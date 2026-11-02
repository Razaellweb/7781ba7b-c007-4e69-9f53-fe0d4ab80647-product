import { afterEach, describe, expect, it, vi } from "vitest";
import { resetGpuModelCatalogCache, searchGpuOffers } from "../../lib/server/vast";

// Locks the documented Vast.ai offers mapping used by the /gpu browse page:
//   GET {base}/bundles/?q=<operator DSL>  with Authorization: Bearer <key>
//   -> { offers: [...] }
//   GET {base}/gpu_names/unique/  -> { gpu_names: [...] }  (exact model spellings)
// and the filtering applied on top of the normalized offer shape.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetGpuModelCatalogCache();
});

// Exact spellings as the live marketplace returns them (spaces, mixed case).
const MODEL_CATALOG = ["A100 SXM4", "H100 NVL", "H100 SXM", "L4", "RTX 4090", "RTX PRO 6000 Max-Q"];

const offer = (overrides: Record<string, unknown> = {}) => ({
  id: 123456,
  gpu_name: "RTX 4090",
  num_gpus: 1,
  gpu_ram: 24576, // megabytes per Vast.ai
  dph_total: 0.42,
  reliability2: 0.991,
  verified: true,
  rentable: true,
  datacenter: true,
  geolocation: "US, California",
  cpu_cores_effective: 8,
  cpu_ram: 32768,
  disk_space: 64,
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A fresh Response per call: a single Response instance can only have its body
// read once, and these tests issue several searches under one mock. Requests are
// routed by path so the model catalog and the offers query answer separately.
const mockOffers = (offers: unknown[], models: string[] | null = MODEL_CATALOG) => {
  vi.stubEnv("VAST_API_KEY", "server-only-vast-key");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input).includes("/gpu_names/unique/")) {
      return models ? json({ success: true, gpu_names: models }) : json({ success: false }, 500);
    }
    return json({ offers });
  });
  const offerCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/bundles/?q="));
  const catalogCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/gpu_names/unique/"));
  const sentQuery = (callIndex = 0) => {
    const url = String(offerCalls()[callIndex]?.[0]);
    return JSON.parse(decodeURIComponent(url.split("q=")[1] ?? "")) as Record<string, unknown>;
  };
  return { fetchMock, sentQuery, offerCalls, catalogCalls };
};

describe("Vast.ai offers search mapping", () => {
  it("normalizes the documented offer fields", async () => {
    mockOffers([offer()]);
    const result = await searchGpuOffers({ limit: 5 });

    expect(result.offers).toHaveLength(1);
    const normalized = result.offers[0];
    expect(normalized.gpuName).toBe("RTX 4090");
    expect(normalized.gpuCount).toBe(1);
    // gpu_ram arrives in MB and is surfaced as VRAM in GB.
    expect(normalized.gpuRamGb).toBe(24);
    expect(normalized.hourlyPriceUsd).toBe(0.42);
    expect(normalized.reliability).toBeCloseTo(0.991);
    expect(normalized.location).toBe("US, California");
    expect(normalized.datacenter).toBe(true);
    expect(result.total).toBe(1);
    // The model filter offers the whole marketplace catalog, not only the
    // models on this page of cheapest offers.
    expect(result.gpuModels).toEqual(MODEL_CATALOG);
  });

  it("falls back to the legacy reliability field", async () => {
    mockOffers([offer({ reliability2: undefined, reliability: 0.87 })]);
    const result = await searchGpuOffers();
    expect(result.offers[0].reliability).toBeCloseTo(0.87);
  });

  it("sends the documented operator DSL for price and reliability", async () => {
    const { sentQuery } = mockOffers([]);
    await searchGpuOffers({ gpuName: "rtx 4090", minReliability: 0.98, minPricePerHour: 0.1, maxPricePerHour: 1, limit: 3 });

    const query = sentQuery();
    // The marketplace matches the spaced display name; "RTX_4090" matches nothing.
    expect(query.gpu_name).toEqual({ eq: "RTX 4090" });
    expect(query.reliability2).toEqual({ gte: 0.98 });
    expect(query.dph_total).toEqual({ gte: 0.1, lte: 1 });
    expect(query.verified).toEqual({ eq: true });
    expect(query.rentable).toEqual({ eq: true });
    expect(query.limit).toBe(3);
    expect(query.order).toEqual([["dph_total", "asc"]]);
  });

  it("filters by free-text search across text fields", async () => {
    mockOffers([
      offer({ id: 1, gpu_name: "RTX 4090", geolocation: "US, California" }),
      offer({ id: 2, gpu_name: "A100 SXM4", geolocation: "DE, Frankfurt" }),
    ]);

    const byModel = await searchGpuOffers({ query: "4090" });
    expect(byModel.offers.map((item) => item.id)).toEqual([1]);
    // The unfiltered catalog size is preserved so the UI can distinguish
    // "empty marketplace" from "no matches".
    expect(byModel.total).toBe(2);

    const byLocation = await searchGpuOffers({ query: "frankfurt" });
    expect(byLocation.offers.map((item) => item.id)).toEqual([2]);

    const noMatch = await searchGpuOffers({ query: "h200" });
    expect(noMatch.offers).toEqual([]);
    expect(noMatch.total).toBe(2);
  });

  it("filters by VRAM in gigabytes and by exact GPU model", async () => {
    mockOffers([
      offer({ id: 1, gpu_name: "RTX 4090", gpu_ram: 24576 }),
      offer({ id: 2, gpu_name: "A100 SXM4", gpu_ram: 81920 }),
    ]);

    const large = await searchGpuOffers({ minGpuRamGb: 40 });
    expect(large.offers.map((item) => item.id)).toEqual([2]);

    const model = await searchGpuOffers({ gpuName: "A100 SXM4" });
    expect(model.offers.map((item) => item.id)).toEqual([2]);
  });

  it("applies a price range to the normalized hourly price", async () => {
    mockOffers([
      offer({ id: 1, dph_total: 0.2 }),
      offer({ id: 2, dph_total: 1.5 }),
      offer({ id: 3, dph_total: 4.0 }),
    ]);
    const result = await searchGpuOffers({ minPricePerHour: 0.5, maxPricePerHour: 2 });
    expect(result.offers.map((item) => item.id)).toEqual([2]);
  });

  it("drops offers whose metric is missing when a bound is requested", async () => {
    mockOffers([offer({ id: 1, gpu_ram: null }), offer({ id: 2, gpu_ram: 40960 })]);
    const result = await searchGpuOffers({ minGpuRamGb: 8 });
    expect(result.offers.map((item) => item.id)).toEqual([2]);
  });

  it("returns an empty catalog when the marketplace has no offers", async () => {
    mockOffers([]);
    const result = await searchGpuOffers();
    expect(result).toEqual({ offers: [], total: 0, gpuModels: MODEL_CATALOG });
  });

  it("returns no model list when both the catalog and the marketplace are empty", async () => {
    mockOffers([], null);
    const result = await searchGpuOffers();
    expect(result).toEqual({ offers: [], total: 0, gpuModels: [] });
  });

  it("maps a selected model to its exact catalog spelling upstream", async () => {
    const { sentQuery } = mockOffers([offer({ gpu_name: "RTX PRO 6000 Max-Q" })]);
    const result = await searchGpuOffers({ gpuName: "RTX PRO 6000 Max-Q" });
    expect(sentQuery().gpu_name).toEqual({ eq: "RTX PRO 6000 Max-Q" });
    expect(result.offers).toHaveLength(1);
  });

  it("still sends the spaced model name when the catalog is unavailable", async () => {
    const { sentQuery } = mockOffers([offer()], null);
    const result = await searchGpuOffers({ gpuName: "rtx_4090" });
    expect(sentQuery().gpu_name).toEqual({ eq: "RTX 4090" });
    expect(result.offers).toHaveLength(1);
  });

  it("sends models named by a text search upstream so pricier machines are found", async () => {
    const { sentQuery } = mockOffers([offer({ gpu_name: "H100 SXM", gpu_ram: 81559, dph_total: 1.9 })]);
    const result = await searchGpuOffers({ query: "h100" });
    expect(sentQuery().gpu_name).toEqual({ in: ["H100 NVL", "H100 SXM"] });
    expect(result.offers.map((item) => item.gpuName)).toEqual(["H100 SXM"]);
  });

  it("does not limit models upstream for text that names no model", async () => {
    const { sentQuery } = mockOffers([offer({ geolocation: "DE, Frankfurt" })]);
    const result = await searchGpuOffers({ query: "frankfurt" });
    expect(sentQuery().gpu_name).toBeUndefined();
    expect(result.offers).toHaveLength(1);
  });

  it("sends the VRAM bound upstream in MB with the reporting tolerance", async () => {
    const { sentQuery } = mockOffers([]);
    await searchGpuOffers({ minGpuRamGb: 80, maxGpuRamGb: 96 });
    expect(sentQuery().gpu_ram).toEqual({ gte: Math.floor(80 * 1024 * 0.93), lte: 96 * 1024 });
  });

  it("keeps cards whose reported VRAM sits just under the marketed size", async () => {
    mockOffers([
      offer({ id: 1, gpu_name: "H100 SXM", gpu_ram: 81559 }), // marketed 80 GB
      offer({ id: 2, gpu_name: "L4", gpu_ram: 23034 }), // marketed 24 GB
      offer({ id: 3, gpu_name: "RTX A4500", gpu_ram: 20470 }), // marketed 20 GB
    ]);
    const atLeast80 = await searchGpuOffers({ minGpuRamGb: 80 });
    expect(atLeast80.offers.map((item) => item.id)).toEqual([1]);
    const atLeast24 = await searchGpuOffers({ minGpuRamGb: 24 });
    expect(atLeast24.offers.map((item) => item.id)).toEqual([1, 2]);
  });

  it("fetches the model catalog once and reuses it", async () => {
    const { catalogCalls, offerCalls } = mockOffers([offer()]);
    await searchGpuOffers();
    await searchGpuOffers({ query: "4090" });
    expect(catalogCalls()).toHaveLength(1);
    expect(offerCalls()).toHaveLength(2);
  });

  it("never sends the key in the URL", async () => {
    const { fetchMock } = mockOffers([offer()]);
    await searchGpuOffers({ query: "4090" });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain("server-only-vast-key");
      expect(String(url)).not.toContain("api_key=");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer server-only-vast-key");
    }
    const [url, init] = fetchMock.mock.calls.find(([candidate]) => String(candidate).includes("/bundles/")) ?? [];
    expect(String(url)).toContain("/bundles/?q=");
    expect(String(url)).not.toContain("server-only-vast-key");
    expect(String(url)).not.toContain("api_key=");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer server-only-vast-key");
  });
});
