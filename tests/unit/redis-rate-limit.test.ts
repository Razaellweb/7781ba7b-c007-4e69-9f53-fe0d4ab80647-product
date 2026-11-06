import { afterEach, describe, expect, it, vi } from "vitest";

// A configured-but-unreachable Redis (e.g. a deleted Upstash database) used to
// make rateLimit throw, which every inference route turned into a 503 before
// any work started: the Playground and the public API were down while Redis
// was. Rate limiting now fails open on a Redis outage, as it already did when
// Redis is not configured; spending stays bounded by prepaid balance and the
// per-request reservation cap.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function load(configured: boolean) {
  vi.stubEnv("UPSTASH_REDIS_REST_URL", configured ? "https://gone-db-00000.upstash.io" : "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", configured ? "token" : "");
  vi.stubEnv("REDIS_REST_URL", "");
  vi.stubEnv("REDIS_REST_TOKEN", "");
  return import("../../lib/server/redis");
}

describe("rateLimit", () => {
  it("lets requests through when Redis is not configured", async () => {
    const { rateLimit } = await load(false);
    expect(await rateLimit("inference:user:a", 1, 60)).toBe(true);
  });

  it("lets requests through, with a warning, when a configured Redis is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed: getaddrinfo ENOTFOUND gone-db-00000.upstash.io"); }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { rateLimit } = await load(true);
    expect(await rateLimit("inference:user:a", 1, 60)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("rate_limit_unavailable"));
  });

  it("lets requests through when Redis answers with an error status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { rateLimit } = await load(true);
    expect(await rateLimit("inference:user:a", 1, 60)).toBe(true);
  });

  it("still enforces the limit when Redis is healthy", async () => {
    let count = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const [cmd] = JSON.parse(init.body);
      return new Response(JSON.stringify({ result: cmd === "INCR" ? ++count : 1 }), { status: 200 });
    }));
    const { rateLimit } = await load(true);
    expect(await rateLimit("inference:user:a", 2, 60)).toBe(true);
    expect(await rateLimit("inference:user:a", 2, 60)).toBe(true);
    expect(await rateLimit("inference:user:a", 2, 60)).toBe(false);
  });
});
