import { vastConfig } from "./config";

// Vast.ai GPU marketplace integration — the credential boundary.
//
// This module is the ONLY place in the application that holds, uses, or even
// reads the Vast.ai API key. Rules enforced here:
//
//   1. The key comes from the server environment (VAST_API_KEY) via vastConfig().
//      It is never accepted from a request, a client, or a user-provided field.
//   2. The key is only ever attached to the outbound request as the documented
//      `Authorization: Bearer <key>` header. It is never put in the URL/query
//      string (which would be captured by access logs) and never in a response.
//   3. Nothing that leaves this module — return values, thrown errors, or log
//      lines — contains the key, the raw upstream payload, or upstream-provided
//      error text. Failures collapse into one sanitized VastUnavailableError.
//
// Wire format (docs.vast.ai → "Search offers"):
//   GET https://console.vast.ai/api/v0/bundles/?q=<url-encoded JSON>
//   Authorization: Bearer <VAST_API_KEY>
// The `q` value is an operator DSL (eq / neq / gt / lt / gte / lte / in / notin)
// and the response is `{ "offers": [ … ] }` where each offer carries the fields
// normalized below. This is a read-only "offers" (bundles) lookup: no ask is
// created and no instance is rented, so the feature stays browse-only.
//
// Two wire details that are easy to get wrong (both checked against the live API):
//   - `gpu_name` matches the display name exactly, with spaces ("RTX 4090").
//     The underscore form ("RTX_4090") matches nothing. Exact names come from
//     GET /api/v0/gpu_names/unique/ → { "gpu_names": [ … ] }.
//   - Upstream returns at most 64 offers per query, cheapest first. A model,
//     VRAM or text constraint applied only to the returned page would hide every
//     machine above the cheapest 64, so those constraints are sent upstream.

export const GPU_OFFERS_UNAVAILABLE_MESSAGE = "GPU offers are temporarily unavailable";

/**
 * Machine-readable failure reason. Lets the API route and the /gpu page show
 * appropriate copy (slow response vs. rate limiting vs. configuration) while the
 * human-readable `message` stays one generic, non-leaking string.
 */
export type VastFailureKind =
  | "unconfigured"
  | "credentials_rejected"
  | "rate_limited"
  | "timeout"
  | "transport"
  | "malformed"
  | "upstream";

/** Sanitized failure surfaced to callers/UI. Carries no credential or upstream detail. */
export class VastUnavailableError extends Error {
  readonly code = "GPU_OFFERS_UNAVAILABLE";
  readonly retryable: boolean;
  readonly kind: VastFailureKind;
  /** Populated when the upstream asks us to back off (HTTP 429 / Retry-After). */
  readonly retryAfterSeconds: number | null;
  constructor(retryable = true, kind: VastFailureKind = "upstream", retryAfterSeconds: number | null = null) {
    super(GPU_OFFERS_UNAVAILABLE_MESSAGE);
    this.name = "VastUnavailableError";
    this.retryable = retryable;
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type GpuOffer = {
  id: number | string | null;
  gpuName: string;
  gpuCount: number | null;
  gpuRamGb: number | null;
  hourlyPriceUsd: number | null;
  storagePriceUsd: number | null;
  reliability: number | null;
  verified: boolean;
  rentable: boolean;
  datacenter: boolean;
  location: string | null;
  cpuCores: number | null;
  ramGb: number | null;
  diskSpaceGb: number | null;
  cudaMaxGood: number | null;
  inetDownMbps: number | null;
  inetUpMbps: number | null;
};

export type GpuOfferFilters = {
  /** Free-text match across the offer's text fields (GPU model, location, host kind). */
  query?: string | null;
  /** Exact GPU model (e.g. "RTX 4090"); case, spaces and underscores are ignored. */
  gpuName?: string | null;
  minReliability?: number | null;
  minPricePerHour?: number | null;
  maxPricePerHour?: number | null;
  minGpuRamGb?: number | null;
  maxGpuRamGb?: number | null;
  limit?: number | null;
};

export type GpuOfferSearchResult = {
  /** Offers matching every supplied filter, cheapest first. */
  offers: GpuOffer[];
  /** Every rentable/verified offer upstream returned before filtering, so the UI
   *  can tell "the marketplace is empty" apart from "nothing matches". */
  total: number;
  /** Every GPU model the marketplace knows (plus any seen in this page), used to populate the model filter. */
  gpuModels: string[];
};

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_SECONDS = 120;
const DEFAULT_RATE_LIMIT_RETRY_SECONDS = 15;
const MODEL_CATALOG_TIMEOUT_MS = 5_000;
const MODEL_CATALOG_TTL_MS = 60 * 60 * 1000;
const MIN_MODEL_SEARCH_LENGTH = 2;
// Cards report usable memory, slightly below the marketed size: an H100 80GB
// reports 81559 MB (79.6 GB), an L4 24GB reports 23034 MB (22.5 GB). A
// "24 GB and up" filter must keep those, so a minimum VRAM bound accepts
// anything within 7% of it. The next tier down stays out (a 20GB A4500
// reports 20470 MB, well under 93% of 24 GB).
const VRAM_REPORTING_TOLERANCE = 0.93;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function safeNumber(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}
function safeInteger(value: unknown): number | null {
  const numeric = safeNumber(value);
  return numeric === null ? null : Math.round(numeric);
}
function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : null;
}

// Normalizes an operator-supplied GPU name into Vast.ai's wire format
// (uppercase, underscores) and rejects anything outside that alphabet so a
// caller can never smuggle arbitrary JSON/DSL through the filter value.
export function normalizeGpuName(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!normalized) return null;
  return /^[A-Z0-9_]{1,40}$/.test(normalized) ? normalized : null;
}

function boundedNumber(value: number | null | undefined, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

// Builds the documented `q` operator DSL. Every constraint that narrows the
// catalog is evaluated upstream: model (exact, or the models a text search
// names), price, VRAM (Vast.ai counts it in MB), reliability, verified/rentable,
// ordering and limit. The same filters are also applied to the normalized
// offers below. That second pass handles what the DSL cannot express, such as
// a text search on location.
function buildQuery(filters: GpuOfferFilters, upstreamModels: string[] | null): Record<string, unknown> {
  const query: Record<string, unknown> = {
    verified: { eq: true },
    rentable: { eq: true },
    order: [["dph_total", "asc"]],
    limit: boundedNumber(filters.limit ?? null, 1, MAX_LIMIT) ?? DEFAULT_LIMIT,
  };
  if (upstreamModels && upstreamModels.length === 1) query.gpu_name = { eq: upstreamModels[0] };
  else if (upstreamModels && upstreamModels.length > 1) query.gpu_name = { in: upstreamModels };
  const minVram = boundedNumber(filters.minGpuRamGb ?? null, 0, 1_024);
  const maxVram = boundedNumber(filters.maxGpuRamGb ?? null, 0, 1_024);
  if (minVram !== null || maxVram !== null) {
    query.gpu_ram = {
      ...(minVram !== null ? { gte: Math.floor(minVram * 1024 * VRAM_REPORTING_TOLERANCE) } : {}),
      ...(maxVram !== null ? { lte: Math.ceil(maxVram * 1024) } : {}),
    };
  }
  const reliability = boundedNumber(filters.minReliability ?? null, 0, 1);
  if (reliability !== null) query.reliability2 = { gte: reliability };
  const maxPrice = boundedNumber(filters.maxPricePerHour ?? null, 0, 1_000);
  const minPrice = boundedNumber(filters.minPricePerHour ?? null, 0, 1_000);
  if (maxPrice !== null || minPrice !== null) {
    query.dph_total = {
      ...(minPrice !== null ? { gte: minPrice } : {}),
      ...(maxPrice !== null ? { lte: maxPrice } : {}),
    };
  }
  return query;
}

// Vast.ai reports `gpu_ram` (and `cpu_ram`) in megabytes; the UI shows gigabytes.
function megabytesToGigabytes(value: number | null): number | null {
  return value === null ? null : Number((value / 1024).toFixed(1));
}

function normalizeOffer(value: unknown): GpuOffer | null {
  const raw = objectValue(value);
  if (!raw) return null;
  const gpuName = safeString(raw.gpu_name);
  if (!gpuName) return null;
  const identifier = typeof raw.id === "number" || typeof raw.id === "string" ? raw.id : null;
  const gpuRamMb = safeNumber(raw.gpu_ram);
  const cpuRamMb = safeNumber(raw.cpu_ram);
  return {
    id: identifier,
    gpuName,
    gpuCount: safeInteger(raw.num_gpus),
    gpuRamGb: megabytesToGigabytes(gpuRamMb),
    hourlyPriceUsd: safeNumber(raw.dph_total),
    storagePriceUsd: safeNumber(raw.storage_total ?? raw.storage_cost),
    // Vast.ai exposes both `reliability2` (precise fraction) and legacy
    // `reliability`; prefer the precise score and fall back to the older field.
    reliability: safeNumber(raw.reliability2) ?? safeNumber(raw.reliability),
    verified: raw.verified === true,
    rentable: raw.rentable !== false,
    datacenter: raw.datacenter === true,
    location: safeString(raw.geolocation),
    cpuCores: safeInteger(raw.cpu_cores_effective ?? raw.cpu_cores),
    ramGb: megabytesToGigabytes(cpuRamMb),
    diskSpaceGb: safeNumber(raw.disk_space),
    cudaMaxGood: safeNumber(raw.cuda_max_good),
    inetDownMbps: safeNumber(raw.inet_down),
    inetUpMbps: safeNumber(raw.inet_up),
  };
}

// Vast.ai reports an invalid/revoked API key with HTTP 404 and an envelope of
// {"success":false,"error":"auth_error","msg":"Invalid user key"}. Only the
// machine-readable error code is inspected; `msg` is never read, stored, or
// forwarded, so no upstream credential detail can escape this module.
function isCredentialRejection(status: number, body: Record<string, unknown>): boolean {
  if (status === 401 || status === 403) return true;
  const error = typeof body.error === "string" ? body.error.toLowerCase() : "";
  return error === "auth_error" || error === "unauthorized" || error === "invalid_key";
}

// Upstream throttling is reported with HTTP 429 and/or a machine-readable
// rate-limit error code.
function isRateLimited(status: number, body: Record<string, unknown>): boolean {
  if (status === 429) return true;
  const error = typeof body.error === "string" ? body.error.toLowerCase() : "";
  const code = typeof body.code === "string" ? body.code.toLowerCase() : "";
  return error === "rate_limit" || error === "rate_limited" || error === "too_many_requests" || code === "rate_limit";
}

// Only the numeric delay is read from Retry-After (never the header text, which
// could echo upstream detail); clamped so a hostile value cannot park the UI.
function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const numeric = Number(raw.trim());
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.round(numeric)));
}

const modelKey = (value: string) => value.trim().toUpperCase().replace(/[\s-]+/g, "_");

// Free-text search across the offer's human-readable text fields.
function matchesQuery(offer: GpuOffer, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    offer.gpuName,
    offer.location ?? "",
    offer.datacenter ? "datacenter" : "host machine",
    offer.verified ? "verified" : "unverified",
    offer.id === null ? "" : String(offer.id),
  ].join(" ").toLowerCase();
  // Model text also matches regardless of spaces vs. underscores ("rtx_4090"),
  // the same way the upstream model lookup does.
  return haystack.includes(needle) || modelKey(haystack).includes(modelKey(needle));
}

function withinRange(value: number | null, min: number | null, max: number | null): boolean {
  if (min === null && max === null) return true;
  // A missing metric cannot be proven to satisfy an explicit bound.
  if (value === null) return false;
  if (min !== null && value < min) return false;
  if (max !== null && value > max) return false;
  return true;
}

function applyFilters(offers: GpuOffer[], filters: GpuOfferFilters): GpuOffer[] {
  const gpuName = filters.gpuName ? modelKey(filters.gpuName) : "";
  const query = filters.query?.trim() ?? "";
  const minPrice = boundedNumber(filters.minPricePerHour ?? null, 0, 1_000);
  const maxPrice = boundedNumber(filters.maxPricePerHour ?? null, 0, 1_000);
  const minVram = boundedNumber(filters.minGpuRamGb ?? null, 0, 1_024);
  const maxVram = boundedNumber(filters.maxGpuRamGb ?? null, 0, 1_024);
  const minReliability = boundedNumber(filters.minReliability ?? null, 0, 1);
  return offers.filter((offer) => {
    if (gpuName && modelKey(offer.gpuName) !== gpuName) return false;
    if (query && !matchesQuery(offer, query)) return false;
    if (!withinRange(offer.hourlyPriceUsd, minPrice, maxPrice)) return false;
    if (!withinRange(offer.gpuRamGb, minVram === null ? null : minVram * VRAM_REPORTING_TOLERANCE, maxVram)) return false;
    if (minReliability !== null && (offer.reliability === null || offer.reliability < minReliability)) return false;
    return true;
  });
}

let modelCatalogCache: { names: string[]; expiresAt: number } | null = null;

/** Clears the cached model catalog. Exposed for tests only. */
export function resetGpuModelCatalogCache(): void {
  modelCatalogCache = null;
}

// Every GPU model name the marketplace knows, in the exact form `gpu_name`
// matches. Cached for an hour because the list changes rarely. A failure is not
// fatal: it returns [] (and caches nothing), and callers fall back to the
// underscore-free display form of the requested model.
async function gpuModelCatalog(config: { apiKey: string; baseUrl: string }): Promise<string[]> {
  if (modelCatalogCache && modelCatalogCache.expiresAt > Date.now()) return modelCatalogCache.names;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_CATALOG_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.baseUrl}/gpu_names/unique/`, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    const body = objectValue(await response.json());
    const raw = response.ok && body && Array.isArray(body.gpu_names) ? body.gpu_names : null;
    const names = raw
      ? Array.from(new Set(raw.map(safeString).filter((name): name is string => name !== null))).sort((a, b) => a.localeCompare(b))
      : [];
    if (names.length === 0) {
      console.error(JSON.stringify({ event: "gpu_model_catalog_unavailable", status: response.status }));
      return [];
    }
    modelCatalogCache = { names, expiresAt: Date.now() + MODEL_CATALOG_TTL_MS };
    return names;
  } catch {
    console.error(JSON.stringify({ event: "gpu_model_catalog_unavailable" }));
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// Works out which exact upstream `gpu_name` values a request is limited to.
// Returns null when the request is not limited by model.
//   - An explicit model maps to its exact catalog spelling ("rtx_4090" →
//     "RTX 4090"). Models missing from the catalog fall back to spaces for
//     underscores, which is the form the marketplace uses.
//   - Otherwise a text search that names models ("h100", "4090") is limited to
//     the catalog models containing it, so expensive machines outside the
//     cheapest page are still found. Text that names no model (a location)
//     only narrows the returned page.
function upstreamModelNames(filters: GpuOfferFilters, catalog: string[]): string[] | null {
  const requested = normalizeGpuName(filters.gpuName);
  if (requested) {
    const exact = catalog.find((name) => modelKey(name) === requested);
    return [exact ?? requested.replace(/_/g, " ")];
  }
  const needle = filters.query ? modelKey(filters.query) : "";
  if (needle.length < MIN_MODEL_SEARCH_LENGTH) return null;
  const named = catalog.filter((name) => modelKey(name).includes(needle));
  return named.length > 0 ? named : null;
}

/**
 * Searches rentable, verified GPU offers on Vast.ai.
 *
 * Read-only and server-only. The API key never leaves this function's request
 * headers. Any credential problem (missing key, revoked key, rejected key) and
 * any upstream failure surface as the same sanitized VastUnavailableError, so a
 * caller cannot distinguish -- and therefore cannot leak -- upstream detail. The
 * failure `kind` only classifies the reason for user-facing copy.
 */
export async function searchGpuOffers(filters: GpuOfferFilters = {}): Promise<GpuOfferSearchResult> {
  const config = vastConfig();
  if (!config.enabled || !config.apiKey || !config.baseUrl) {
    // Missing configuration is a normal degraded state, not a crash. Log the
    // event name only -- never the value or any part of it.
    console.error(JSON.stringify({ event: "gpu_offers_credentials_missing" }));
    // Retrying cannot help until the server credential is configured.
    throw new VastUnavailableError(false, "unconfigured");
  }

  const catalogModels = await gpuModelCatalog({ apiKey: config.apiKey, baseUrl: config.baseUrl });
  const query = buildQuery(filters, upstreamModelNames(filters, catalogModels));
  const endpoint = `${config.baseUrl}/bundles/?q=${encodeURIComponent(JSON.stringify(query))}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  let payload: unknown;
  try {
    try {
      response = await fetch(endpoint, {
        method: "GET",
        headers: {
          // Documented Vast.ai REST authentication: Bearer API key. Header only --
          // never the `?api_key=` query-parameter alternative.
          Authorization: `Bearer ${config.apiKey}`,
          Accept: "application/json",
        },
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      // A slow/hanging upstream is aborted by the timeout above; anything else is
      // a transport problem. Both are retryable and identical to the caller.
      const timedOut = controller.signal.aborted
        || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
      console.error(JSON.stringify({ event: timedOut ? "gpu_offers_timeout" : "gpu_offers_transport_failed" }));
      throw new VastUnavailableError(true, timedOut ? "timeout" : "transport");
    }

    try {
      payload = await response.json();
    } catch {
      // Non-JSON body: an HTML error page, a truncated response, a proxy banner.
      console.error(JSON.stringify({ event: "gpu_offers_malformed_response", stage: "parse" }));
      throw new VastUnavailableError(true, "malformed");
    }
  } finally {
    clearTimeout(timeout);
  }

  const body = objectValue(payload) ?? {};

  if (isRateLimited(response.status, body)) {
    const wait = retryAfterSeconds(response) ?? DEFAULT_RATE_LIMIT_RETRY_SECONDS;
    console.error(JSON.stringify({ event: "gpu_offers_upstream_failed", reason: "rate_limited", status: response.status, retryAfterSeconds: wait }));
    throw new VastUnavailableError(true, "rate_limited", wait);
  }

  if (!response.ok || body.success === false) {
    // 401/403 and Vast's auth_error envelope mean the server-held credential was
    // missing/rejected; everything else is an upstream problem. Both are
    // reported identically downstream -- only the reason tag differs.
    const rejected = isCredentialRejection(response.status, body);
    console.error(JSON.stringify({ event: "gpu_offers_upstream_failed", reason: rejected ? "credentials_rejected" : "upstream_error", status: response.status }));
    // A rejected credential is not retryable until configuration changes;
    // a transient upstream error is.
    throw new VastUnavailableError(!rejected, rejected ? "credentials_rejected" : "upstream");
  }

  const rawOffers = Array.isArray(body.offers) ? body.offers : null;
  if (!rawOffers) {
    // The request succeeded but the payload does not match the documented shape
    // (`{ offers: [...] }`), so nothing on this page can be trusted.
    console.error(JSON.stringify({ event: "gpu_offers_malformed_response" }));
    throw new VastUnavailableError(true, "malformed");
  }

  const catalog = rawOffers.map(normalizeOffer).filter((offer): offer is GpuOffer => offer !== null);
  // The model filter lists every model the marketplace knows, not only the ones
  // in this page of cheapest offers, so high-end GPUs can be selected at all.
  const gpuModels = Array.from(new Set([...catalogModels, ...catalog.map((offer) => offer.gpuName)])).sort((a, b) => a.localeCompare(b));
  const offers = applyFilters(catalog, filters);

  return { offers, total: catalog.length, gpuModels };
}

/** Convenience wrapper returning only the filtered offer list. */
export async function listGpuOffers(filters: GpuOfferFilters = {}): Promise<GpuOffer[]> {
  const result = await searchGpuOffers(filters);
  return result.offers;
}
