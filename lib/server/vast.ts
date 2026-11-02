import { VAST_API_KEY_VARIABLES, vastApiBaseUrl, vastApiKeySource, vastConfig } from "./config";

// Vast.ai GPU marketplace integration — the credential boundary.
//
// This module is the ONLY place in the application that holds, uses, or even
// reads the Vast.ai API key. Rules enforced here:
//
//   1. The key comes from the server environment (VAST_API_KEY, or any of the
//      other documented spellings accepted by config.ts) via vastConfig(). It is
//      never accepted from a request, a client, or a user-provided field.
//   2. The key is only ever attached to the outbound request as the documented
//      `Authorization: Bearer <key>` header. It is never put in the URL/query
//      string (which would be captured by access logs) and never in a response.
//   3. Nothing that leaves this module — return values, thrown errors, or log
//      lines — contains the key, the raw upstream payload, or upstream-provided
//      error text. Failures collapse into one sanitized VastUnavailableError, and
//      the read-only diagnostics below report only presence + host + reason.
//
// Wire format (docs.vast.ai → "Search offers"):
//   GET https://console.vast.ai/api/v0/bundles/?q=<url-encoded JSON>
//   Authorization: Bearer <VAST_API_KEY>
// The `q` value is an operator DSL (eq / neq / gt / lt / gte / lte / in / notin)
// and the response is `{ "offers": [ … ] }` where each offer carries the fields
// normalized below. Offer search is read-only; renting is the separate
// instance section at the end of this module.
//
// Three wire details that are easy to get wrong (all checked against the live API):
//   - `gpu_name` matches the display name exactly, with spaces ("RTX 4090").
//     The underscore form ("RTX_4090") matches nothing. Exact names come from
//     GET /api/v0/gpu_names/unique/ → { "gpu_names": [ … ] }.
//   - Upstream returns at most 64 offers per query, cheapest first. A model,
//     VRAM or text constraint applied only to the returned page would hide every
//     machine above the cheapest 64, so those constraints are sent upstream.
//   - The API answers on both console.vast.ai and cloud.vast.ai. A deployment
//     whose egress cannot resolve one of them must not look like "no offers", so
//     both documented hosts are tried and whichever answers is remembered.

export const GPU_OFFERS_UNAVAILABLE_MESSAGE = "GPU offers are temporarily unavailable";

/** The two documented API hosts. The first is the documented default. */
const DOCUMENTED_BASE_URLS = ["https://console.vast.ai/api/v0", "https://cloud.vast.ai/api/v0"] as const;

/**
 * The base URL that last answered successfully, per server process.
 *
 * Marketplace reads and lifecycle writes must both target the host that actually
 * answered, so the first success pins the host for subsequent calls instead of
 * paying the failed probe again on every request.
 */
let preferredBaseUrl: string | null = null;

/** Test/ops helper: forget the pinned host so the next call re-probes. */
export function resetVastEndpointPreference(): void {
  preferredBaseUrl = null;
}

/** The host to use next: the one that worked, else the configured default. */
export function marketplaceBaseUrl(): string {
  return preferredBaseUrl ?? vastApiBaseUrl();
}

/**
 * Every base URL worth trying, configured host first.
 *
 * A custom VAST_API_BASE_URL is honoured first and is never duplicated. The
 * documented hosts follow so a DNS/egress problem with one of them does not
 * present as an empty marketplace.
 */
export function candidateBaseUrls(): string[] {
  const configured = marketplaceBaseUrl();
  const list = [configured, ...DOCUMENTED_BASE_URLS];
  return Array.from(new Set(list.map((value) => value.replace(/\/+$/, ""))));
}

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
  | "upstream"
  /** The marketplace refused a rental request (for example the offer was taken). */
  | "request_rejected";

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
  /** Ports the host can expose directly; each setup needs a few. */
  directPortCount: number | null;
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
    directPortCount: safeInteger(raw.direct_port_count),
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
 * One read-only offer page from ONE host. Returns the normalized body or throws a
 * sanitized failure, so the caller can decide whether another host is worth
 * trying.
 */
async function fetchOffersFrom(
  host: string,
  apiKey: string,
  query: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown>; latencyMs: number }> {
  const endpoint = `${host}/bundles/?q=${encodeURIComponent(JSON.stringify(query))}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  let response: Response;
  let payload: unknown;
  try {
    try {
      response = await fetch(endpoint, {
        method: "GET",
        headers: {
          // Documented Vast.ai REST authentication: Bearer API key. Header only --
          // never the `?api_key=` query-parameter alternative.
          Authorization: `Bearer ${apiKey}`,
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
      console.error(JSON.stringify({ event: timedOut ? "gpu_offers_timeout" : "gpu_offers_transport_failed", host }));
      throw new VastUnavailableError(true, timedOut ? "timeout" : "transport");
    }

    try {
      payload = await response.json();
    } catch {
      // Non-JSON body: an HTML error page, a truncated response, a proxy banner.
      console.error(JSON.stringify({ event: "gpu_offers_malformed_response", stage: "parse", host }));
      throw new VastUnavailableError(true, "malformed");
    }
  } finally {
    clearTimeout(timeout);
  }

  const body = objectValue(payload) ?? {};
  const latencyMs = Date.now() - startedAt;

  if (isRateLimited(response.status, body)) {
    const wait = retryAfterSeconds(response) ?? DEFAULT_RATE_LIMIT_RETRY_SECONDS;
    console.error(JSON.stringify({ event: "gpu_offers_upstream_failed", reason: "rate_limited", status: response.status, retryAfterSeconds: wait, host }));
    throw new VastUnavailableError(true, "rate_limited", wait);
  }

  if (!response.ok || body.success === false) {
    // 401/403 and Vast's auth_error envelope mean the server-held credential was
    // missing/rejected; everything else is an upstream problem. Both are
    // reported identically downstream -- only the reason tag differs.
    const rejected = isCredentialRejection(response.status, body);
    console.error(JSON.stringify({ event: "gpu_offers_upstream_failed", reason: rejected ? "credentials_rejected" : "upstream_error", status: response.status, host }));
    // A rejected credential is not retryable until configuration changes;
    // a transient upstream error is.
    throw new VastUnavailableError(!rejected, rejected ? "credentials_rejected" : "upstream");
  }

  if (!Array.isArray(body.offers)) {
    // The request succeeded but the payload does not match the documented shape
    // (`{ offers: [...] }`), so nothing on this page can be trusted.
    console.error(JSON.stringify({ event: "gpu_offers_malformed_response", host }));
    throw new VastUnavailableError(true, "malformed");
  }

  return { status: response.status, body, latencyMs };
}

/**
 * Searches rentable, verified GPU offers on Vast.ai.
 *
 * Read-only and server-only. The API key never leaves this function's request
 * headers. Any credential problem (missing key, revoked key, rejected key) and
 * any upstream failure surface as the same sanitized VastUnavailableError, so a
 * caller cannot distinguish -- and therefore cannot leak -- upstream detail. The
 * failure `kind` only classifies the reason for user-facing copy.
 *
 * Endpoint resilience: a transport/DNS failure or a non-JSON answer is retried on
 * the other documented host, and the host that answered is remembered so later
 * marketplace and lifecycle calls go straight there. Credential and throttling
 * failures are NOT retried elsewhere -- they are not host-specific.
 */
export async function searchGpuOffers(filters: GpuOfferFilters = {}): Promise<GpuOfferSearchResult> {
  const config = vastConfig();
  if (!config.enabled || !config.apiKey) {
    // Missing configuration is a normal degraded state, not a crash. Log the
    // event name only -- never the value or any part of it.
    console.error(JSON.stringify({ event: "gpu_offers_credentials_missing" }));
    // Retrying cannot help until the server credential is configured.
    throw new VastUnavailableError(false, "unconfigured");
  }

  const catalogModels = await gpuModelCatalog({ apiKey: config.apiKey, baseUrl: marketplaceBaseUrl() });
  const query = buildQuery(filters, upstreamModelNames(filters, catalogModels));

  let lastFailure: VastUnavailableError | null = null;
  for (const host of candidateBaseUrls()) {
    try {
      const { body } = await fetchOffersFrom(host, config.apiKey, query);
      preferredBaseUrl = host;
      const rawOffers = body.offers as unknown[];
      const catalog = rawOffers.map(normalizeOffer).filter((offer): offer is GpuOffer => offer !== null);
      // The model filter lists every model the marketplace knows, not only the ones
      // in this page of cheapest offers, so high-end GPUs can be selected at all.
      const gpuModels = Array.from(new Set([...catalogModels, ...catalog.map((offer) => offer.gpuName)])).sort((a, b) => a.localeCompare(b));
      const offers = applyFilters(catalog, filters);
      return { offers, total: catalog.length, gpuModels };
    } catch (error) {
      const failure = error instanceof VastUnavailableError ? error : new VastUnavailableError(true, "upstream");
      lastFailure = failure;
      // Only an endpoint-specific failure is worth trying on another host.
      if (failure.kind !== "transport" && failure.kind !== "timeout" && failure.kind !== "malformed") throw failure;
      console.error(JSON.stringify({ event: "gpu_offers_host_unavailable", host, kind: failure.kind }));
    }
  }
  throw lastFailure ?? new VastUnavailableError(true, "upstream");
}

/** Convenience wrapper returning only the filtered offer list. */
export async function listGpuOffers(filters: GpuOfferFilters = {}): Promise<GpuOffer[]> {
  const result = await searchGpuOffers(filters);
  return result.offers;
}

// ---------------------------------------------------------------------------
// Instances (rentals). Same credential boundary as offer search: the key only
// travels as a Bearer header, and every failure becomes a sanitized
// VastUnavailableError. Wire formats follow Vast.ai's official CLI:
//   PUT    /api/v0/asks/{offer_id}/          rent an offer → { success, new_contract }
//   GET    /api/v0/instances/{id}/?owner=me  → { instances: {...} | null }
//   DELETE /api/v0/instances/{id}/           → { success }
//   POST   /api/v0/instances/{id}/ssh/       { ssh_key }
//   GET    /api/v1/instances/?select_filters=<json>  → { instances: [...] }
// ---------------------------------------------------------------------------

export type VastInstance = {
  id: number;
  /** running | loading | exited | created | null while the host schedules it. */
  actualStatus: string | null;
  intendedStatus: string | null;
  publicIp: string | null;
  /** Container port ("22/tcp") → public host port. */
  ports: Record<string, number>;
  jupyterToken: string | null;
  hourlyPriceUsd: number | null;
  label: string | null;
};

export type InstanceSpec = {
  image: string;
  /** Container env vars plus "-p <port>:<port>" port mappings, in Vast's env form. */
  env: Record<string, string>;
  onstart: string;
  runtype: string;
  diskGb: number;
  label: string;
  useJupyterLab: boolean;
};

function requireVast(): { apiKey: string; baseUrl: string } {
  const config = vastConfig();
  if (!config.enabled || !config.apiKey) {
    console.error(JSON.stringify({ event: "gpu_rental_credentials_missing" }));
    throw new VastUnavailableError(false, "unconfigured");
  }
  return { apiKey: config.apiKey, baseUrl: marketplaceBaseUrl() };
}

// One authenticated JSON request. Returns the HTTP status and parsed object
// body. Transport, timeout, throttling and credential failures throw
// sanitized errors; other non-2xx answers are returned for the caller to judge.
async function vastRequest(path: string, init: { method: string; body?: unknown; event: string; absoluteUrl?: string }): Promise<{ status: number; body: Record<string, unknown> }> {
  const config = requireVast();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  let payload: unknown = null;
  try {
    try {
      response = await fetch(init.absoluteUrl ?? `${config.baseUrl}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          Accept: "application/json",
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = controller.signal.aborted || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
      console.error(JSON.stringify({ event: init.event, reason: timedOut ? "timeout" : "transport" }));
      throw new VastUnavailableError(true, timedOut ? "timeout" : "transport");
    }
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  } finally {
    clearTimeout(timeout);
  }
  const body = objectValue(payload) ?? {};
  if (isRateLimited(response.status, body)) {
    console.error(JSON.stringify({ event: init.event, reason: "rate_limited", status: response.status }));
    throw new VastUnavailableError(true, "rate_limited", retryAfterSeconds(response) ?? DEFAULT_RATE_LIMIT_RETRY_SECONDS);
  }
  if (isCredentialRejection(response.status, body)) {
    console.error(JSON.stringify({ event: init.event, reason: "credentials_rejected", status: response.status }));
    throw new VastUnavailableError(false, "credentials_rejected");
  }
  return { status: response.status, body };
}

function normalizeInstance(value: unknown): VastInstance | null {
  const raw = objectValue(value);
  if (!raw) return null;
  const id = safeInteger(raw.id);
  if (id === null) return null;
  const ports: Record<string, number> = {};
  const rawPorts = objectValue(raw.ports);
  if (rawPorts) {
    for (const [containerPort, bindings] of Object.entries(rawPorts)) {
      const first = Array.isArray(bindings) ? objectValue(bindings[0]) : null;
      const hostPort = first ? safeInteger(first.HostPort) : null;
      if (hostPort !== null && /^\d{1,5}\/(tcp|udp)$/.test(containerPort)) ports[containerPort] = hostPort;
    }
  }
  const ip = safeString(raw.public_ipaddr);
  return {
    id,
    actualStatus: safeString(raw.actual_status),
    intendedStatus: safeString(raw.intended_status),
    publicIp: ip && /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip : null,
    ports,
    jupyterToken: typeof raw.jupyter_token === "string" && /^[A-Za-z0-9_-]{8,200}$/.test(raw.jupyter_token) ? raw.jupyter_token : null,
    hourlyPriceUsd: safeNumber(raw.dph_total),
    label: safeString(raw.label),
  };
}

/**
 * Looks up one offer by id with the same verified/rentable constraints as the
 * browse page. Returns null when it is no longer on the market. Used at launch
 * so the price charged comes from the marketplace, never from the client.
 */
export async function getRentableOffer(offerId: number): Promise<GpuOffer | null> {
  if (!Number.isSafeInteger(offerId) || offerId <= 0) return null;
  const query = { id: { eq: offerId }, verified: { eq: true }, rentable: { eq: true }, limit: 1 };
  const { status, body } = await vastRequest(`/bundles/?q=${encodeURIComponent(JSON.stringify(query))}`, { method: "GET", event: "gpu_offer_lookup_failed" });
  if (status < 200 || status >= 300 || !Array.isArray(body.offers)) {
    console.error(JSON.stringify({ event: "gpu_offer_lookup_failed", reason: "upstream_error", status }));
    throw new VastUnavailableError(true, "upstream");
  }
  const offer = body.offers.map(normalizeOffer).find((candidate) => candidate !== null && String(candidate.id) === String(offerId));
  return offer ?? null;
}

/** Rents an offer. Returns the new instance id. */
export async function createInstance(offerId: number, spec: InstanceSpec): Promise<number> {
  const { status, body } = await vastRequest(`/asks/${offerId}/`, {
    method: "PUT",
    event: "gpu_instance_create_failed",
    body: {
      client_id: "me",
      image: spec.image,
      env: spec.env,
      disk: spec.diskGb,
      label: spec.label,
      onstart: spec.onstart,
      runtype: spec.runtype,
      use_jupyter_lab: spec.useJupyterLab,
      python_utf8: true,
      lang_utf8: true,
      // Fail instead of queueing when the machine is no longer available.
      cancel_unavail: true,
    },
  });
  const instanceId = safeInteger(body.new_contract);
  if (status >= 200 && status < 300 && body.success !== false && instanceId !== null) return instanceId;
  const rejected = status >= 400 && status < 500;
  console.error(JSON.stringify({ event: "gpu_instance_create_failed", reason: rejected ? "request_rejected" : "upstream_error", status }));
  throw new VastUnavailableError(!rejected, rejected ? "request_rejected" : "upstream");
}

/** Current state of an instance, or null when it no longer exists. */
export async function getInstance(instanceId: number): Promise<VastInstance | null> {
  const { status, body } = await vastRequest(`/instances/${instanceId}/?owner=me`, { method: "GET", event: "gpu_instance_lookup_failed" });
  if (status === 404) return null;
  if (status < 200 || status >= 300) {
    console.error(JSON.stringify({ event: "gpu_instance_lookup_failed", reason: "upstream_error", status }));
    throw new VastUnavailableError(true, "upstream");
  }
  if (!("instances" in body)) {
    console.error(JSON.stringify({ event: "gpu_instance_lookup_failed", reason: "malformed" }));
    throw new VastUnavailableError(true, "malformed");
  }
  return normalizeInstance(body.instances);
}

/** Destroys an instance. An instance that is already gone counts as destroyed. */
export async function destroyInstance(instanceId: number): Promise<void> {
  const { status, body } = await vastRequest(`/instances/${instanceId}/`, { method: "DELETE", event: "gpu_instance_destroy_failed", body: {} });
  if (status >= 200 && status < 300 && body.success !== false) return;
  if (status === 404 || (await getInstance(instanceId)) === null) return;
  console.error(JSON.stringify({ event: "gpu_instance_destroy_failed", reason: "upstream_error", status }));
  throw new VastUnavailableError(true, "upstream");
}

/** Adds a public SSH key to a running instance. */
export async function attachSshKey(instanceId: number, publicKey: string): Promise<void> {
  const { status, body } = await vastRequest(`/instances/${instanceId}/ssh/`, { method: "POST", event: "gpu_instance_ssh_attach_failed", body: { ssh_key: publicKey } });
  if (status >= 200 && status < 300 && body.success !== false) return;
  console.error(JSON.stringify({ event: "gpu_instance_ssh_attach_failed", reason: "upstream_error", status }));
  throw new VastUnavailableError(true, "upstream");
}

/**
 * Finds the instance created with `label`, for launches whose create call
 * timed out after the marketplace may already have created the machine.
 */
export async function findInstanceByLabel(label: string): Promise<VastInstance | null> {
  const { baseUrl } = requireVast();
  const filters = encodeURIComponent(JSON.stringify({ label: { eq: label } }));
  const url = `${baseUrl.replace(/\/api\/v0$/, "")}/api/v1/instances/?select_filters=${filters}`;
  const { status, body } = await vastRequest("", { method: "GET", event: "gpu_instance_label_lookup_failed", absoluteUrl: url });
  if (status < 200 || status >= 300 || !Array.isArray(body.instances)) {
    console.error(JSON.stringify({ event: "gpu_instance_label_lookup_failed", reason: "upstream_error", status }));
    throw new VastUnavailableError(true, "upstream");
  }
  const match = body.instances.map(normalizeInstance).find((instance) => instance?.label === label);
  return match ?? null;
}

// ---------------------------------------------------------------------------
// Diagnostics (READ-ONLY).
// ---------------------------------------------------------------------------
// "The key is set but nothing shows" has a small number of causes, and the
// product must be able to say which one instead of rendering a generic
// unavailable panel. These helpers report PRESENCE and NETWORK OUTCOME only: the
// variable name that supplied the key, the hosts that were tried, each host's
// outcome and latency, and how many offers came back. They never return the key,
// a fragment of it, an upstream error message, or a response body.

/** Non-secret configuration facts, safe to render on the GPU page. */
export type VastMarketplaceConfigReport = {
  /** True when a key is present (any accepted variable) and not the placeholder. */
  configured: boolean;
  /** The environment variable that supplied the key, or null. Never the value. */
  keyVariable: string | null;
  /** Environment variables checked, so the page can say what to add. */
  acceptedKeyVariables: string[];
  /** Hosts that may be tried, in order. */
  hosts: string[];
  /** The host the last successful call used, or null before the first success. */
  activeHost: string | null;
};

export function describeVastMarketplaceConfig(): VastMarketplaceConfigReport {
  const { value, variable } = vastApiKeySource();
  return {
    configured: Boolean(value),
    keyVariable: variable,
    acceptedKeyVariables: [...VAST_API_KEY_VARIABLES],
    hosts: candidateBaseUrls(),
    activeHost: preferredBaseUrl,
  };
}

/** One host's attempt, as reported to the operator. No upstream text. */
export type VastMarketplaceAttempt = {
  host: string;
  /** ok | auth | rate_limited | timeout | transport | http_error | malformed | skipped */
  outcome: "ok" | "auth" | "rate_limited" | "timeout" | "transport" | "http_error" | "malformed" | "skipped";
  /** HTTP status when a response arrived. */
  status: number | null;
  latencyMs: number | null;
  /** Offers returned by this host's probe. */
  offerCount: number | null;
  /** Total offers the probe page contained, before any filter. */
  total: number | null;
  /** Stable reason tag for the UI copy. */
  reason: string | null;
};

export type VastMarketplaceDiagnosis = {
  config: VastMarketplaceConfigReport;
  attempts: VastMarketplaceAttempt[];
  /** Host that answered with offers, if any. */
  healthyHost: string | null;
  /** Offers visible through the probe query (rentable + verified). */
  offersVisible: number;
  /** GPU models visible through the probe. */
  modelsVisible: number;
  latencyMs: number | null;
  /** True when at least one host answered successfully. */
  reachable: boolean;
  /** Operator-facing summary of what to fix, or null when nothing is wrong. */
  hint: string | null;
};

/**
 * Probes the marketplace with ONE minimal, read-only offers query per candidate
 * host and reports exactly what happened.
 *
 * Read-only: it calls GET /bundles/ with a small limit. It never rents, stops or
 * mutates anything, and it is safe to call from a page render.
 */
export async function diagnoseVastMarketplace(): Promise<VastMarketplaceDiagnosis> {
  const config = describeVastMarketplaceConfig();

  if (!config.configured) {
    return {
      config,
      attempts: config.hosts.map((host) => ({ host, outcome: "skipped" as const, status: null, latencyMs: null, offerCount: null, total: null, reason: "No API key is configured on the server." })),
      healthyHost: null,
      offersVisible: 0,
      modelsVisible: 0,
      latencyMs: null,
      reachable: false,
      hint: `Add the vast.ai account API key (console.vast.ai → Account → API Keys) as ${config.acceptedKeyVariables[0]}, then redeploy. Accepted variables: ${config.acceptedKeyVariables.join(", ")}.`,
    };
  }

  const { value: apiKey } = vastApiKeySource();
  const attempts: VastMarketplaceAttempt[] = [];
  let healthyHost: string | null = null;
  let offersVisible = 0;
  let modelsVisible = 0;
  let latencyMs: number | null = null;

  const probeQuery = { verified: { eq: true }, rentable: { eq: true }, order: [["dph_total", "asc"]], limit: 8 };

  for (const host of config.hosts) {
    if (!apiKey) break;
    const attemptStarted = Date.now();
    try {
      const { status, body } = await fetchOffersFrom(host, apiKey, probeQuery);
      const rawOffers = Array.isArray(body.offers) ? body.offers : [];
      const offers = rawOffers.map(normalizeOffer).filter((offer): offer is GpuOffer => offer !== null);
      const models = new Set(offers.map((offer) => offer.gpuName));
      attempts.push({ host, outcome: "ok", status, latencyMs: Date.now() - attemptStarted, offerCount: offers.length, total: offers.length, reason: null });
      healthyHost = host;
      preferredBaseUrl = host;
      offersVisible = offers.length;
      modelsVisible = models.size;
      latencyMs = Date.now() - attemptStarted;
      break;
    } catch (error) {
      const failure = error instanceof VastUnavailableError ? error : new VastUnavailableError(true, "upstream");
      const outcome: VastMarketplaceAttempt["outcome"] =
        failure.kind === "credentials_rejected" ? "auth"
          : failure.kind === "rate_limited" ? "rate_limited"
            : failure.kind === "timeout" ? "timeout"
              : failure.kind === "transport" ? "transport"
                : failure.kind === "malformed" ? "malformed"
                  : "http_error";
      attempts.push({
        host,
        outcome,
        status: null,
        latencyMs: Date.now() - attemptStarted,
        offerCount: null,
        total: null,
        reason: outcome === "auth" ? "The API key was rejected (invalid or revoked)."
          : outcome === "rate_limited" ? "The marketplace asked us to slow down."
            : outcome === "timeout" ? "The marketplace did not answer in time."
              : outcome === "transport" ? "This host could not be reached from the server (DNS/egress)."
                : outcome === "malformed" ? "The host answered with something that was not a marketplace payload."
                  : "The marketplace returned an error.",
      });
      // A credential/throttling failure is not host-specific: stop probing.
      if (outcome === "auth" || outcome === "rate_limited") break;
    }
  }

  if (healthyHost && offersVisible === 0) {
    return {
      config: { ...config, activeHost: healthyHost },
      attempts,
      healthyHost,
      offersVisible,
      modelsVisible,
      latencyMs,
      reachable: true,
      // Reaching the API with a valid key but seeing no offers is a marketplace
      // state (or an account-level one), not a configuration bug.
      hint: "The API answered and accepted the key, but no rentable verified offers came back. That is a marketplace/account state rather than a configuration problem — refresh in a moment, and confirm billing is enabled on the vast.ai account.",
    };
  }

  const authRejected = attempts.some((attempt) => attempt.outcome === "auth");
  const unreachable = attempts.length > 0 && attempts.every((attempt) => attempt.outcome === "transport" || attempt.outcome === "timeout");
  const hint = healthyHost
    ? null
    : authRejected
      ? "The configured vast.ai API key was rejected. Create a new key at console.vast.ai → Account → API Keys, update the environment variable, then redeploy."
      : unreachable
        ? "No vast.ai host could be reached from the server. Check the deployment's outbound network access (DNS/egress) for console.vast.ai and cloud.vast.ai."
        : "The marketplace could not answer. Retry shortly; the credential is present and nothing in the workspace is affected.";

  return {
    config: { ...config, activeHost: healthyHost },
    attempts,
    healthyHost,
    offersVisible,
    modelsVisible,
    latencyMs,
    reachable: Boolean(healthyHost),
    hint,
  };
}
