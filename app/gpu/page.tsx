"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import { LaunchDialog, MachinesSection, type LaunchableOffer, type Rental, type RentalSettings } from "./machines";

type GpuOffer = {
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
  directPortCount: number | null;
};

type OffersResponse = {
  offers?: unknown;
  total?: unknown;
  gpuModels?: unknown;
  error?: unknown;
  code?: unknown;
  kind?: unknown;
  retryable?: unknown;
  retryAfterSeconds?: unknown;
};

type LoadState = "loading" | "ready" | "error";

type Failure = {
  title: string;
  message: string;
  hint: string;
};

type Filters = {
  search: string;
  gpuModel: string;
  minPrice: string;
  maxPrice: string;
  minVram: string;
};

/** The query set that has actually been committed (post-debounce). */
type AppliedQuery = { query: string; active: boolean };

const EMPTY_FILTERS: Filters = { search: "", gpuModel: "", minPrice: "", maxPrice: "", minVram: "" };

const UNAVAILABLE = "GPU offers are temporarily unavailable";
const FILTER_DEBOUNCE_MS = 400;
const REQUEST_TIMEOUT_MS = 20_000;
const SLOW_HINT_MS = 1_800;
const REQUEST_LIMIT = "200";
const MACHINES_POLL_MS = 15_000;

type MachinesState = { rentals: Rental[]; balanceUsd: number | null; settings: RentalSettings | null; unavailable: string | null };

// VRAM presets in gigabytes. Empty means "any".
const VRAM_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Any VRAM" },
  { value: "8", label: "8 GB and up" },
  { value: "16", label: "16 GB and up" },
  { value: "24", label: "24 GB and up" },
  { value: "40", label: "40 GB and up" },
  { value: "80", label: "80 GB and up" },
];

const priceLabel = (value: number | null) =>
  value === null ? "—" : `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;

const reliabilityLabel = (value: number | null) =>
  value === null ? "—" : `${(value * 100).toFixed(value >= 0.995 ? 0 : 1)}%`;

const vramLabel = (value: number | null) =>
  value === null ? "—" : `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)} GB`;

const gpuInitials = (name: string) => {
  const cleaned = name.replace(/[^A-Za-z0-9 ]+/g, " ").trim();
  const letters = cleaned.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 2) return letters.slice(0, 2).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase() || "GPU";
};

/** Normalizes a user-typed price bound; invalid input is simply ignored. */
const priceBound = (value: string): number | null => {
  if (!value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
};

const isFiltering = (filters: Filters) =>
  Boolean(
    filters.search.trim() ||
    filters.gpuModel ||
    filters.minPrice.trim() ||
    filters.maxPrice.trim() ||
    filters.minVram,
  );

/** Builds the request query string for a filter set (never includes credentials). */
const queryFor = (filters: Filters): string => {
  const params = new URLSearchParams();
  const trimmed = filters.search.trim();
  if (trimmed) params.set("q", trimmed);
  if (filters.gpuModel) params.set("gpu", filters.gpuModel);
  const low = priceBound(filters.minPrice);
  const high = priceBound(filters.maxPrice);
  if (low !== null) params.set("minPricePerHour", String(low));
  if (high !== null) params.set("maxPricePerHour", String(high));
  if (filters.minVram) params.set("minGpuRamGb", filters.minVram);
  params.set("limit", REQUEST_LIMIT);
  return params.toString();
};

// Failure copy. Every branch is generic and user-facing: no upstream status,
// host, driver, stack, or credential detail is ever rendered.
const unreachableFailure = (): Failure => ({
  title: "Offers could not be loaded",
  message: `${UNAVAILABLE}. We could not reach the offers service from this workspace.`,
  hint: "Check your connection, then retry — browsing resumes as soon as the service answers.",
});

const timeoutFailure = (): Failure => ({
  title: "This is taking longer than expected",
  message: "The offers service did not respond in time, so the request was stopped. Your workspace is unaffected.",
  hint: "Retry to send the request again, or adjust a filter to start a fresh query.",
});

const malformedFailure = (): Failure => ({
  title: "Unexpected response",
  message: "The marketplace replied with something this page could not read, so nothing is shown instead of stale numbers.",
  hint: "Retry in a moment — this is usually a transient upstream issue.",
});

const rateLimitedFailure = (seconds: number | null): Failure => ({
  title: "Too many requests",
  message:
    seconds !== null && seconds > 0
      ? `The marketplace asked us to slow down. Try again in about ${seconds} second${seconds === 1 ? "" : "s"}.`
      : "The marketplace asked us to slow down. Try again in a moment.",
  hint: "Offer requests are already debounced; waiting briefly is enough.",
});

const sessionFailure = (): Failure => ({
  title: "Session expired",
  message: "Your sign-in is no longer valid, so offers could not be authorised.",
  hint: "Sign in again from the entry screen to keep browsing.",
});

const configurationFailure = (): Failure => ({
  title: "Offers could not be loaded",
  message: `${UNAVAILABLE}. This is a service-side configuration issue, so there is nothing to change in your account.`,
  hint: "The catalog returns as soon as the provider credential is restored.",
});

const retrySeconds = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;

/** Maps a non-OK proxy response to user copy without echoing backend internals. */
const failureForResponse = (data: OffersResponse, status: number): Failure => {
  if (status === 401) return sessionFailure();
  const kind = typeof data.kind === "string" ? data.kind : "";
  if (status === 429 || kind === "rate_limited") return rateLimitedFailure(retrySeconds(data.retryAfterSeconds));
  if (kind === "unconfigured" || kind === "credentials_rejected") return configurationFailure();
  if (kind === "timeout") return timeoutFailure();
  if (kind === "malformed") return malformedFailure();
  return unreachableFailure();
};

/** A single normalized offer, or null when the entry is not usable. */
const coerceOffer = (value: unknown): GpuOffer | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.gpuName !== "string" || !candidate.gpuName.trim()) return null;
  const numeric = (input: unknown): number | null =>
    typeof input === "number" && Number.isFinite(input) ? input : null;
  const text = (input: unknown): string | null => (typeof input === "string" ? input : null);
  const identifier = typeof candidate.id === "number" || typeof candidate.id === "string" ? candidate.id : null;
  return {
    id: identifier,
    gpuName: candidate.gpuName,
    gpuCount: numeric(candidate.gpuCount),
    gpuRamGb: numeric(candidate.gpuRamGb),
    hourlyPriceUsd: numeric(candidate.hourlyPriceUsd),
    storagePriceUsd: numeric(candidate.storagePriceUsd),
    reliability: numeric(candidate.reliability),
    verified: candidate.verified === true,
    rentable: candidate.rentable !== false,
    datacenter: candidate.datacenter === true,
    location: text(candidate.location),
    cpuCores: numeric(candidate.cpuCores),
    ramGb: numeric(candidate.ramGb),
    diskSpaceGb: numeric(candidate.diskSpaceGb),
    cudaMaxGood: numeric(candidate.cudaMaxGood),
    inetDownMbps: numeric(candidate.inetDownMbps),
    inetUpMbps: numeric(candidate.inetUpMbps),
    directPortCount: numeric(candidate.directPortCount),
  };
};

/** Opens the launch dialog for this offer, or explains why it cannot launch. */
function LaunchControl({ onLaunch, disabledReason }: { onLaunch: () => void; disabledReason: string | null }) {
  return (
    <div className="gpu-launch">
      <div className="gpu-launch-row">
        <button
          type="button"
          className="gpu-pill is-warm gpu-launch-button"
          onClick={onLaunch}
          disabled={Boolean(disabledReason)}
          title={disabledReason ?? undefined}
        >
          Launch
          <span className="gpu-launch-arrow" aria-hidden="true">↗</span>
        </button>
        <span className="gpu-launch-state">
          <i aria-hidden="true" /> {disabledReason ? disabledReason.toUpperCase() : "BILLED PER MINUTE"}
        </span>
      </div>
    </div>
  );
}

function OfferCard({ offer, onLaunch, launchDisabledReason }: { offer: GpuOffer; onLaunch: (offer: GpuOffer) => void; launchDisabledReason: string | null }) {
  const reliability = offer.reliability;
  const reliabilityWidth = reliability === null ? 0 : Math.max(2, Math.min(100, reliability * 100));
  const lowReliability = reliability !== null && reliability < 0.9;
  return (
    <article className="gpu-offer">
      <div className="gpu-offer-top">
        <span className="gpu-glyph" aria-hidden="true">{gpuInitials(offer.gpuName)}</span>
        <span className={`gpu-offer-flag${offer.datacenter ? " is-datacenter" : ""}`}>
          <i aria-hidden="true" />
          {offer.datacenter ? "DATACENTER" : "HOST MACHINE"}
        </span>
      </div>
      <h3>{offer.gpuName}</h3>
      <p className="gpu-offer-location">{offer.location ?? "Location not reported"}</p>
      <ul className="gpu-tags">
        {offer.gpuCount !== null && <li>{offer.gpuCount} × GPU</li>}
        {offer.inetDownMbps !== null && <li>{Math.round(offer.inetDownMbps)} Mbps down</li>}
        {offer.cpuCores !== null && <li>{offer.cpuCores} CPU cores</li>}
        {offer.ramGb !== null && <li>{vramLabel(offer.ramGb)} host RAM</li>}
      </ul>
      <dl className="gpu-metrics">
        <div>
          <dt>VRAM / GPU</dt>
          <dd>{vramLabel(offer.gpuRamGb)}</dd>
        </div>
        <div>
          <dt>RELIABILITY</dt>
          <dd>{reliabilityLabel(reliability)}</dd>
          <div className={`gpu-reliability${lowReliability ? " is-low" : ""}`} aria-hidden="true">
            <span style={{ width: `${reliabilityWidth}%` }} />
          </div>
        </div>
      </dl>
      <div className="gpu-offer-foot">
        <span className="gpu-price">
          {priceLabel(offer.hourlyPriceUsd)}
          <small>/ HR</small>
        </span>
        <span className="gpu-offer-id">{offer.id === null ? "OFFER · —" : `OFFER · ${offer.id}`}</span>
      </div>
      <LaunchControl onLaunch={() => onLaunch(offer)} disabledReason={launchDisabledReason} />
    </article>
  );
}

function OfferSkeletons() {
  return (
    <div className="gpu-grid" aria-hidden="true">
      {Array.from({ length: 8 }).map((_, index) => (
        <article className="gpu-offer gpu-skeleton" key={index}>
          <div className="gpu-offer-top">
            <span className="sk sk-glyph" />
            <span className="sk" style={{ width: "34%", height: 9 }} />
          </div>
          <div className="sk sk-line w-70" />
          <div className="sk sk-line w-45" />
          <ul className="gpu-tags">
            <li className="sk sk-chip" />
            <li className="sk sk-chip" />
          </ul>
          <div className="sk sk-block" />
          <div className="sk-foot">
            <span className="sk" />
            <span className="sk" />
          </div>
          <div className="sk sk-foot">
            <span className="sk sk-launch" />
          </div>
        </article>
      ))}
    </div>
  );
}

function RetryButton({ onRetry, busy, label = "Retry" }: { onRetry: () => void; busy: boolean; label?: string }) {
  return (
    <button className="gpu-pill is-warm" type="button" onClick={onRetry} disabled={busy}>
      {busy ? "Retrying…" : label}
      <span aria-hidden="true">↻</span>
    </button>
  );
}

/**
 * GPU marketplace page. Offers and machines come from authenticated backend
 * endpoints, which hold the provider credential server-side — the browser never
 * talks to the provider and never handles a provider key. Launching, billing and
 * stopping all run on the server (lib/server/gpu-rentals.ts).
 */
export default function GpuPage() {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const router = useRouter();

  // Raw filter input state. Nothing here triggers a request directly.
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  // The filter set that has actually been committed (after debouncing).
  const [applied, setApplied] = useState<AppliedQuery>(() => ({ query: queryFor(EMPTY_FILTERS), active: false }));

  // Results state.
  const [offers, setOffers] = useState<GpuOffer[]>([]);
  const [gpuModels, setGpuModels] = useState<string[]>([]);
  const [catalogTotal, setCatalogTotal] = useState<number>(0);
  const [state, setState] = useState<LoadState>("loading");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);
  const [slow, setSlow] = useState(false);
  // Bumped on Refresh/Retry so an unchanged query still refetches.
  const [attempt, setAttempt] = useState(0);

  // Rented machines, balance, and launch settings.
  const [machines, setMachines] = useState<MachinesState>({ rentals: [], balanceUsd: null, settings: null, unavailable: null });
  const [launchTarget, setLaunchTarget] = useState<GpuOffer | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [machineNotice, setMachineNotice] = useState<string | null>(null);

  const requestRef = useRef<AbortController | null>(null);
  const loadedOnceRef = useRef(false);
  const hasResultsRef = useRef(false);
  const mountedRef = useRef(true);

  const desiredQuery = useMemo(() => queryFor(filters), [filters]);
  const desiredActive = isFiltering(filters);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
    };
  }, []);

  // Debounce: a burst of keystrokes or filter edits commits exactly one query.
  useEffect(() => {
    if (desiredQuery === applied.query) {
      if (desiredActive !== applied.active) setApplied({ query: desiredQuery, active: desiredActive });
      return;
    }
    const timer = window.setTimeout(() => setApplied({ query: desiredQuery, active: desiredActive }), FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [desiredQuery, desiredActive, applied.query, applied.active]);

  // "Still working" hint for slow networks — shown without blocking the page.
  useEffect(() => {
    if (!pending) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), SLOW_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);

  const authHeaders = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) throw new Error("AUTH_REQUIRED");
    return { Authorization: `Bearer ${token}` } as Record<string, string>;
  }, [getAccessToken]);

  // Fetches one committed query. Any in-flight request is aborted first, so a slow
  // response can never overwrite a newer one. Stable identity: reads mutable facts
  // from refs so the fetch effect never re-runs spuriously.
  const load = useCallback(async (query: string) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    if (mountedRef.current) {
      setPending(true);
      // The first load of a session is a full skeleton state; later loads keep the
      // current grid visible while the new one is fetched.
      if (!loadedOnceRef.current) {
        setState("loading");
        setFailure(null);
      }
    }

    const fail = (next: Failure) => {
      if (!mountedRef.current) return;
      // A failed refresh keeps the last confirmed results on screen instead of
      // collapsing the grid; only a failure with no results is a full error state.
      setState(hasResultsRef.current ? "ready" : "error");
      setFailure(next);
    };

    try {
      const headers = await authHeaders();
      const response = await fetch(`/api/gpu/offers?${query}`, { headers, cache: "no-store", signal: controller.signal });
      if (controller.signal.aborted || !mountedRef.current) return;

      // Read as text first: a non-JSON body (proxy error page, truncated stream)
      // must be reported as malformed instead of silently becoming {}.
      const raw = await response.text();
      if (controller.signal.aborted || !mountedRef.current) return;

      let parsed: OffersResponse | null = null;
      if (raw.trim()) {
        try {
          const value = JSON.parse(raw) as unknown;
          parsed = value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as OffersResponse)
            : null;
        } catch {
          parsed = null;
        }
      }

      if (!response.ok) {
        fail(failureForResponse(parsed ?? {}, response.status));
        return;
      }

      if (!parsed || !Array.isArray(parsed.offers)) {
        fail(malformedFailure());
        return;
      }

      const nextOffers = parsed.offers
        .map(coerceOffer)
        .filter((offer): offer is GpuOffer => offer !== null);

      // A non-empty payload with zero usable entries is a malformed response.
      if (parsed.offers.length > 0 && nextOffers.length === 0) {
        fail(malformedFailure());
        return;
      }

      if (Array.isArray(parsed.gpuModels)) {
        const models = parsed.gpuModels.filter(
          (model): model is string => typeof model === "string" && Boolean(model.trim()),
        );
        // Union with previously known models so the filter never loses options
        // because of one narrow query.
        setGpuModels((current) => Array.from(new Set([...current, ...models])).sort((a, b) => a.localeCompare(b)));
      }
      if (typeof parsed.total === "number" && Number.isFinite(parsed.total) && parsed.total >= 0) {
        setCatalogTotal(parsed.total);
      }

      hasResultsRef.current = nextOffers.length > 0;
      loadedOnceRef.current = true;
      setOffers(nextOffers);
      setFailure(null);
      setState("ready");
    } catch (caught) {
      if (!mountedRef.current) return;
      if (caught instanceof Error && caught.message === "AUTH_REQUIRED") {
        hasResultsRef.current = false;
        setState("error");
        setFailure(sessionFailure());
        return;
      }
      if (controller.signal.aborted) {
        // Our own timeout vs. a superseded request.
        if (timedOut) fail(timeoutFailure());
        return;
      }
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      fail(unreachableFailure());
    } finally {
      window.clearTimeout(timeout);
      if (requestRef.current === controller) {
        requestRef.current = null;
        if (mountedRef.current) setPending(false);
      }
    }
  }, [authHeaders]);

  const loadMachines = useCallback(async () => {
    try {
      const headers = await authHeaders();
      const response = await fetch("/api/gpu/instances", { headers, cache: "no-store" });
      const data = (await response.json().catch(() => null)) as { rentals?: Rental[]; balanceUsd?: number; settings?: RentalSettings; error?: string } | null;
      if (!mountedRef.current) return;
      if (!response.ok || !data) {
        setMachines((current) => ({ ...current, unavailable: data?.error ?? "GPU machines are temporarily unavailable." }));
        return;
      }
      setMachines({ rentals: Array.isArray(data.rentals) ? data.rentals : [], balanceUsd: typeof data.balanceUsd === "number" ? data.balanceUsd : null, settings: data.settings ?? null, unavailable: null });
    } catch {
      if (mountedRef.current) setMachines((current) => ({ ...current, unavailable: current.settings ? null : "GPU machines are temporarily unavailable." }));
    }
  }, [authHeaders]);

  const launch = useCallback(async (input: { template: string; model: string | null; sshPublicKey: string | null }): Promise<string | null> => {
    if (!launchTarget) return "Choose a machine first.";
    try {
      const headers = await authHeaders();
      const response = await fetch("/api/gpu/instances", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ offerId: launchTarget.id, ...input }),
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) return data?.error ?? "The machine could not be launched. Nothing was charged.";
      setLaunchTarget(null);
      setMachineNotice("Machine launched. It shows up below while it starts.");
      await loadMachines();
      document.getElementById("your-machines")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return null;
    } catch {
      return "The machine could not be launched. Check your connection and try again.";
    }
  }, [authHeaders, launchTarget, loadMachines]);

  const stop = useCallback(async (rental: Rental) => {
    setStopping(rental.id);
    try {
      const headers = await authHeaders();
      const response = await fetch(`/api/gpu/instances/${rental.id}`, { method: "DELETE", headers });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      setMachineNotice(response.ok ? "Machine stopped. Unused prepaid time was returned to your balance." : data?.error ?? "The machine could not be stopped. Try again.");
      await loadMachines();
    } catch {
      setMachineNotice("The machine could not be stopped. Check your connection and try again.");
    } finally {
      if (mountedRef.current) setStopping(null);
    }
  }, [authHeaders, loadMachines]);

  // Unauthenticated visitors are sent through the Privy entry flow, exactly like
  // Overview and Playground.
  useEffect(() => {
    if (ready && !authenticated) router.replace("/signup");
  }, [ready, authenticated, router]);

  // One effect owns fetching: the committed query plus the attempt counter. Pressing
  // Refresh or Retry bumps the counter, which re-issues the very same request.
  useEffect(() => {
    if (!ready || !authenticated) return;
    void load(applied.query);
  }, [applied.query, attempt, ready, authenticated, load]);

  // Machines load once, then refresh while any is starting or running.
  const hasActiveMachine = machines.rentals.some((rental) => rental.status === "launching" || rental.status === "running");
  useEffect(() => {
    if (!ready || !authenticated) return;
    void loadMachines();
  }, [ready, authenticated, loadMachines]);
  useEffect(() => {
    if (!ready || !authenticated || !hasActiveMachine) return;
    const timer = window.setInterval(() => void loadMachines(), MACHINES_POLL_MS);
    return () => window.clearInterval(timer);
  }, [ready, authenticated, hasActiveMachine, loadMachines]);

  const update = useCallback(<K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
  }, []);

  const resetFilters = useCallback(() => setFilters(EMPTY_FILTERS), []);

  const refresh = useCallback(() => setAttempt((current) => current + 1), []);

  // Retry genuinely re-fetches: the error is cleared and a new attempt is issued.
  const retry = useCallback(() => {
    setFailure(null);
    setAttempt((current) => current + 1);
  }, []);

  if (!ready || !authenticated) {
    return <main className="gpu-gate">{ready ? "Redirecting to sign in…" : "Restoring your session…"}</main>;
  }

  const activeMachines = machines.rentals.filter((rental) => rental.status === "launching" || rental.status === "running").length;
  const launchDisabledReason = machines.unavailable
    ? "Not available yet"
    : !machines.settings
      ? "Loading"
      : activeMachines >= machines.settings.maxActiveRentals
        ? `Limit of ${machines.settings.maxActiveRentals} running`
        : null;

  const loadingInitial = state === "loading";
  const hasResults = offers.length > 0;
  const showErrorPanel = state === "error" && !hasResults;
  const showEmpty = state === "ready" && !hasResults;
  const statusCopy = pending
    ? "Updating offers…"
    : state === "error"
      ? "Marketplace unavailable"
      : applied.active
        ? "Filters applied"
        : "Showing the full marketplace";
  const scopeCopy = loadingInitial
    ? "—"
    : applied.active
      ? `${offers.length} of ${catalogTotal} in catalog`
      : `${catalogTotal || offers.length} in catalog`;

  return (
    <>
      <header className="gpu-heading">
        <div className="gpu-heading-copy">
          <span className="gpu-kicker">WORKSPACE / COMPUTE LAYER</span>
          <h1>GPUs<span>.</span></h1>
          <p className="gpu-subtitle">Rent a GPU by the minute, paid from your compute balance. Pick a machine, choose a setup, and connect from your browser or terminal.</p>
        </div>
        <button className="gpu-pill gpu-refresh" type="button" onClick={refresh} disabled={pending}>
          {pending ? "Refreshing" : "Refresh"}
          <span aria-hidden="true">↻</span>
        </button>
      </header>

      <MachinesSection rentals={machines.rentals} onStop={(rental) => void stop(rental)} stopping={stopping} notice={machineNotice} />

      <section className="gpu-controls" aria-label="Offer search and filters">
        <div className="gpu-search-row">
          <label className="gpu-field gpu-field-search">
            <span className="gpu-field-label">SEARCH</span>
            <input
              type="search"
              value={filters.search}
              onChange={(event) => update("search", event.target.value)}
              placeholder="GPU model, location, offer…"
              aria-label="Search GPU offers"
              autoComplete="off"
            />
          </label>
          <span className={`gpu-status${pending ? " is-busy" : state === "error" ? " is-error" : ""}`} role="status">
            <i aria-hidden="true" />
            {statusCopy}
          </span>
          <span className="gpu-search-meta" aria-live="polite">{scopeCopy}</span>
        </div>

        <div className="gpu-filter-row">
          <label className="gpu-field">
            <span className="gpu-field-label">GPU MODEL</span>
            <select value={filters.gpuModel} onChange={(event) => update("gpuModel", event.target.value)} aria-label="Filter by GPU model">
              <option value="">All models</option>
              {gpuModels.map((model) => <option value={model} key={model}>{model}</option>)}
            </select>
          </label>
          <label className="gpu-field">
            <span className="gpu-field-label">PRICE / HOUR (USD)</span>
            <span className="gpu-price-range">
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={filters.minPrice}
                onChange={(event) => update("minPrice", event.target.value)}
                placeholder="Min"
                aria-label="Minimum price per hour in USD"
              />
              <em>to</em>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={filters.maxPrice}
                onChange={(event) => update("maxPrice", event.target.value)}
                placeholder="Max"
                aria-label="Maximum price per hour in USD"
              />
            </span>
          </label>
          <label className="gpu-field">
            <span className="gpu-field-label">VRAM</span>
            <select value={filters.minVram} onChange={(event) => update("minVram", event.target.value)} aria-label="Filter by minimum VRAM">
              {VRAM_OPTIONS.map((option) => <option value={option.value} key={option.value || "any"}>{option.label}</option>)}
            </select>
          </label>
          <button className="gpu-pill gpu-reset" type="button" onClick={resetFilters} disabled={!desiredActive}>
            Reset
          </button>
        </div>
      </section>

      <section className="gpu-results" aria-labelledby="gpu-results-title" aria-busy={pending}>
        <div className="gpu-results-head">
          <div className="gpu-results-title-wrap">
            <span className="gpu-kicker">AVAILABLE OFFERS</span>
            <h2 id="gpu-results-title">Machines on the market.</h2>
          </div>
          <span className="gpu-results-meta">
            {loadingInitial
              ? "QUERYING THE MARKETPLACE"
              : `${offers.length} ${offers.length === 1 ? "OFFER" : "OFFERS"} · ${gpuModels.length} ${gpuModels.length === 1 ? "MODEL" : "MODELS"}`}
          </span>
        </div>

        {/* Thin progress indicator: a refetch never hides or blocks the page. */}
        <div className={`gpu-progress${pending ? " is-active" : ""}`} aria-hidden="true">
          <span />
        </div>

        {slow && (
          <p className="gpu-slow-hint" role="status">
            Still loading — the marketplace is responding slowly. Filters stay editable while this finishes.
          </p>
        )}

        {failure && hasResults && (
          <div className="gpu-inline-error" role="status">
            <span>{failure.message} The offers below are the last confirmed response.</span>
            <RetryButton onRetry={retry} busy={pending} />
          </div>
        )}

        {loadingInitial ? (
          <>
            <p className="gpu-loading-line" role="status">
              <span className="gpu-spinner" aria-hidden="true" /> Reading live availability from the marketplace…
            </p>
            <OfferSkeletons />
          </>
        ) : showErrorPanel ? (
          <div className="gpu-panel is-error" role="alert">
            <span className="gpu-panel-mark" aria-hidden="true">!</span>
            <div className="gpu-panel-body">
              <span className="gpu-panel-overline">UNAVAILABLE</span>
              <h2>{failure?.title ?? "Offers could not be loaded"}</h2>
              <p>{failure?.message ?? `${UNAVAILABLE}. The marketplace may be unreachable right now; your workspace is unaffected.`}</p>
              <p className="gpu-panel-hint">{failure?.hint ?? "Retry in a moment — browsing resumes as soon as the service answers."}</p>
              <div className="gpu-panel-actions">
                <RetryButton onRetry={retry} busy={pending} />
                {desiredActive && (
                  <button className="gpu-pill" type="button" onClick={resetFilters}>
                    Reset filters
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : showEmpty && applied.active && catalogTotal > 0 ? (
          <div className="gpu-panel" role="status">
            <span className="gpu-panel-mark" aria-hidden="true">⌕</span>
            <div className="gpu-panel-body">
              <span className="gpu-panel-overline">NO OFFERS FOUND</span>
              <h2>No offers match these filters</h2>
              <p>Offers are available, but none satisfy the current search, model, price, and VRAM constraints. Loosen a filter to see more machines.</p>
              <div className="gpu-panel-actions">
                <button className="gpu-pill" type="button" onClick={resetFilters}>Reset filters</button>
                <button className="gpu-pill" type="button" onClick={refresh} disabled={pending}>
                  {pending ? "Refreshing…" : "Refresh ↻"}
                </button>
              </div>
            </div>
          </div>
        ) : showEmpty ? (
          <div className="gpu-panel" role="status">
            <span className="gpu-panel-mark" aria-hidden="true">✦</span>
            <div className="gpu-panel-body">
              <span className="gpu-panel-overline">NO OFFERS FOUND</span>
              <h2>No offers found</h2>
              <p>
                {applied.active
                  ? "No rentable machines matched this query. Loosen a filter or refresh to ask the marketplace again."
                  : "The marketplace returned no rentable machines at this moment. Nothing is wrong with your account — check back shortly."}
              </p>
              <div className="gpu-panel-actions">
                <button className="gpu-pill" type="button" onClick={refresh} disabled={pending}>
                  {pending ? "Checking…" : "Check again ↻"}
                </button>
                {desiredActive && (
                  <button className="gpu-pill" type="button" onClick={resetFilters}>
                    Reset filters
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="gpu-grid">
            {offers.map((offer, index) => (
              <OfferCard offer={offer} key={`${offer.id ?? "offer"}-${index}`} onLaunch={setLaunchTarget} launchDisabledReason={offer.id === null ? "Unavailable" : launchDisabledReason} />
            ))}
          </div>
        )}

        <p className="gpu-footnote">Prices are hourly and include everything you are charged. Time comes out of your compute balance per minute; stopping a machine deletes its disk.{machines.unavailable ? ` ${machines.unavailable}` : ""}</p>
      </section>

      {launchTarget && machines.settings && (
        <LaunchDialog
          offer={launchTarget as LaunchableOffer}
          settings={machines.settings}
          balanceUsd={machines.balanceUsd}
          onClose={() => setLaunchTarget(null)}
          onLaunch={launch}
        />
      )}
    </>
  );
}
