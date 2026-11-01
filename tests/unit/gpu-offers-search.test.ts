import { afterEach, describe, expect, it, vi } from "vitest";
import { searchGpuOffers } from "../../lib/server/vast";

// Locks the documented Vast.ai offers mapping used by the /gpu browse page:
//   GET {base}/bundles/?q=<operator DSL>  with Authorization: Bearer <key>
//   -> { offers: [...] }
// and the filtering applied on top of the normalized offer shape.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

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

// A fresh Response per call: a single Response instance can only have its body
// read once, and these tests issue several searches under one mock.
const mockOffers = (offers: unknown[]) => {
  vi.stubEnv("VAST_API_KEY", "server-only-vast-key");
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify({ offers }), { status: 200, headers: { "content-type": "application/json" } }),
  );
  const sentQuery = (callIndex = 0) => {
    const url = String(fetchMock.mock.calls[callIndex]?.[0]);
    return JSON.parse(decodeURIComponent(url.split("q=")[1] ?? "")) as Record<string, unknown>;
  };
  return { fetchMock, sentQuery };
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
    expect(result.gpuModels).toEqual(["RTX 4090"]);
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
    expect(query.gpu_name).toEqual({ eq: "RTX_4090" });
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
    expect(result).toEqual({ offers: [], total: 0, gpuModels: [] });
  });

  it("never sends the key in the URL", async () => {
    const { fetchMock } = mockOffers([offer()]);
    await searchGpuOffers({ query: "4090" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/bundles/?q=");
    expect(String(url)).not.toContain("server-only-vast-key");
    expect(String(url)).not.toContain("api_key=");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer server-only-vast-key");
  });
});
