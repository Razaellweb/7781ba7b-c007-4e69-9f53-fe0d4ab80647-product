import { afterEach, describe, expect, it, vi } from "vitest";
import { listGpuOffers, resetGpuModelCatalogCache, searchGpuOffers, VastUnavailableError, GPU_OFFERS_UNAVAILABLE_MESSAGE } from "../../lib/server/vast";
import { VAST_API_KEY_PLACEHOLDER } from "../../lib/server/config";

// These tests lock the Vast.ai credential boundary: the key is server-only, it
// travels exclusively as an Authorization Bearer header, and every credential or
// upstream failure collapses into one sanitized error with no upstream detail.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetGpuModelCatalogCache();
});

const offer = {
  id: 123456,
  gpu_name: "RTX 4090",
  num_gpus: 1,
  gpu_ram: 24576,
  dph_total: 0.42,
  reliability2: 0.99,
  verified: true,
  rentable: true,
  datacenter: false,
  geolocation: "US, California",
  cpu_cores_effective: 8,
  cpu_ram: 32768,
  disk_space: 64,
};

// Answers the model-catalog lookup with a small catalog and every offers query
// with `offersResponse()`. A fresh Response per call, because a body can only be
// read once.
const mockMarketplace = (offersResponse: () => Response) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    String(input).includes("/gpu_names/unique/")
      ? new Response(JSON.stringify({ success: true, gpu_names: ["A100 SXM4", "RTX 4090"] }), { status: 200 })
      : offersResponse(),
  );

const offersCall = (fetchMock: ReturnType<typeof mockMarketplace>) =>
  fetchMock.mock.calls.find(([url]) => String(url).includes("/bundles/")) ?? [];

// Serializes everything an error could expose so a test can assert the key and
// upstream text never appear anywhere in it.
const describeError = (error: unknown) => JSON.stringify({
  name: error instanceof Error ? error.name : typeof error,
  message: error instanceof Error ? error.message : String(error),
  own: error instanceof Error ? Object.fromEntries(Object.entries(error)) : {},
  stack: error instanceof Error ? error.stack ?? "" : "",
});

describe("Vast.ai offers credential boundary", () => {
  it("attaches the server-held key as a Bearer header and never in the URL", async () => {
    vi.stubEnv("VAST_API_KEY", "server-only-vast-key");
    const fetchMock = mockMarketplace(() =>
      new Response(JSON.stringify({ offers: [offer] }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    const offers = await listGpuOffers({ gpuName: "rtx 4090", limit: 5 });

    const [url, init] = offersCall(fetchMock);
    expect(String(url)).not.toContain("server-only-vast-key");
    expect(String(url)).not.toContain("api_key=");
    expect(String(url).startsWith("https://console.vast.ai/api/v0/bundles/?q=")).toBe(true);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer server-only-vast-key");
    expect(offers).toHaveLength(1);
    expect(offers[0].gpuName).toBe("RTX 4090");
    expect(offers[0].hourlyPriceUsd).toBe(0.42);
    expect(JSON.stringify(offers)).not.toContain("server-only-vast-key");
  });

  it("sends the normalized filter DSL without leaking the key", async () => {
    vi.stubEnv("VAST_API_KEY", "server-only-vast-key");
    const fetchMock = mockMarketplace(() => new Response(JSON.stringify({ offers: [] }), { status: 200 }));

    await listGpuOffers({ gpuName: "rtx 4090", minReliability: 0.98, maxPricePerHour: 1, limit: 3 });

    const url = String(offersCall(fetchMock)[0]);
    const query = JSON.parse(decodeURIComponent(url.split("q=")[1] ?? "")) as Record<string, unknown>;
    expect(query.gpu_name).toEqual({ eq: "RTX 4090" });
    expect(query.reliability2).toEqual({ gte: 0.98 });
    expect(query.dph_total).toEqual({ lte: 1 });
    expect(query.limit).toBe(3);
    expect(query.verified).toEqual({ eq: true });
    expect(query.rentable).toEqual({ eq: true });
  });

  it("fails sanitized when the server key is missing", async () => {
    vi.stubEnv("VAST_API_KEY", "");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(listGpuOffers()).rejects.toBeInstanceOf(VastUnavailableError);
    await expect(listGpuOffers()).rejects.toThrow(GPU_OFFERS_UNAVAILABLE_MESSAGE);
    // No request is attempted without a credential.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats the seeded placeholder value as a missing key", async () => {
    vi.stubEnv("VAST_API_KEY", VAST_API_KEY_PLACEHOLDER);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    let caught: unknown;
    try { await searchGpuOffers(); } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(VastUnavailableError);
    expect((caught as VastUnavailableError).kind).toBe("unconfigured");
    expect((caught as VastUnavailableError).retryable).toBe(false);
    // The placeholder is never sent upstream as if it were a credential.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats Vast.ai's 404 auth_error envelope as a rejected credential without echoing it", async () => {
    vi.stubEnv("VAST_API_KEY", "revoked-key-value");
    mockMarketplace(() =>
      new Response(JSON.stringify({ success: false, error: "auth_error", msg: "Invalid user key" }), { status: 404 }),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    let caught: unknown;
    try { await listGpuOffers(); } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(VastUnavailableError);
    const serialized = describeError(caught);
    expect(serialized).not.toContain("revoked-key-value");
    expect(serialized).not.toContain("Invalid user key");
    expect(serialized).not.toContain("auth_error");
    expect((caught as VastUnavailableError).message).toBe(GPU_OFFERS_UNAVAILABLE_MESSAGE);
    expect((caught as VastUnavailableError).retryable).toBe(false);
    expect((caught as VastUnavailableError).kind).toBe("credentials_rejected");
  });

  it("does not leak upstream status text on a generic upstream failure", async () => {
    vi.stubEnv("VAST_API_KEY", "server-only-vast-key");
    mockMarketplace(() => new Response("internal stack trace and hostnames", { status: 502 }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    let caught: unknown;
    try { await listGpuOffers(); } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(VastUnavailableError);
    const serialized = describeError(caught);
    expect(serialized).not.toContain("internal stack trace");
    expect((caught as VastUnavailableError).retryable).toBe(true);
  });
});
