import { afterEach, describe, expect, it, vi } from "vitest";
import { getInferenceProvider } from "../../lib/server/provider";
import type { InferenceChunk, InferenceRequest } from "../../lib/server/inference";

// Provider failover (PRD: normalized errors + optional single retry on the
// fallback provider, recording which provider served the response).
//
// These tests drive the real wrapper through getInferenceProvider() with the two
// HTTP transports stubbed per endpoint, so what is asserted is the actual routing
// decision rather than a mock of the decision.

const VAST = "http://gpu.invalid:8000/v1/chat/completions";
const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

function vastEnv() {
  vi.stubEnv("INFERENCE_PROVIDER", "vast");
  vi.stubEnv("VAST_INFERENCE_BASE_URL", "http://gpu.invalid:8000/v1");
  vi.stubEnv("VAST_INFERENCE_TIMEOUT_MS", "60000");
  vi.stubEnv("VAST_INFERENCE_IDLE_TIMEOUT_MS", "60000");
  vi.stubEnv("VAST_INFERENCE_MAX_RETRIES", "0");
  vi.stubEnv("OPENROUTER_ENABLED", "true");
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
}

const sse = (frames: string[]) => new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

/** A 200 SSE body that yields one delta then a clean finish. */
const openRouterOk = () => sse([
  'data: {"choices":[{"delta":{"content":"from openrouter"}}]}\n\n',
  'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":2,"completion_tokens":3,"cost":0.000001}}\n\n',
  "data: [DONE]\n\n",
]);

const request: InferenceRequest = { operationKey: "op-fallback", model: "glm-4.6", messages: [{ role: "user", content: "hello" }] };

async function collect(chunks: AsyncIterable<InferenceChunk>) {
  const out: InferenceChunk[] = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
}

/** Routes the stubbed fetch by endpoint so each provider can be driven separately. */
function routeFetch(handlers: { vast: () => Response | Promise<Response>; openrouter?: () => Response | Promise<Response> }) {
  const calls: string[] = [];
  const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === VAST) return handlers.vast();
    if (url === OPENROUTER && handlers.openrouter) return handlers.openrouter();
    return new Response("unexpected", { status: 500 });
  });
  return { mock, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("provider failover", () => {
  it("retries once on the fallback when the primary has an outage and failover is enabled", async () => {
    vastEnv();
    vi.stubEnv("INFERENCE_FALLBACK_ENABLED", "true");
    vi.stubEnv("INFERENCE_FALLBACK_PROVIDER", "openrouter");

    const { calls } = routeFetch({
      vast: () => new Response("upstream down", { status: 503 }),
      openrouter: openRouterOk,
    });

    const chunks = await collect(getInferenceProvider().stream(request));
    const terminal = chunks.at(-1);
    // The request transparently succeeded: no error chunk, served by OpenRouter.
    expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
    if (terminal?.type !== "complete") throw new Error("expected a complete terminal event");
    expect(terminal.output).toBe("from openrouter");
    expect(terminal.servedBy).toBe("openrouter");
    expect(terminal.failedOver).toBe(true);
    // Exactly one attempt per provider: the fallback is a single retry.
    expect(calls.filter((url) => url === VAST)).toHaveLength(1);
    expect(calls.filter((url) => url === OPENROUTER)).toHaveLength(1);
  });

  it("never falls back on an authentication failure (misconfiguration, not outage)", async () => {
    vastEnv();
    vi.stubEnv("INFERENCE_FALLBACK_ENABLED", "true");
    vi.stubEnv("INFERENCE_FALLBACK_PROVIDER", "openrouter");

    const { calls } = routeFetch({
      vast: () => new Response("invalid key", { status: 401 }),
      openrouter: openRouterOk,
    });

    const chunks = await collect(getInferenceProvider().stream(request));
    const failure = chunks.find((chunk) => chunk.type === "error");
    expect(failure?.type === "error" ? failure.error.code : "").toBe("authentication");
    expect(failure?.type === "error" ? failure.error.retryable : true).toBe(false);
    // OpenRouter was never contacted.
    expect(calls.filter((url) => url === OPENROUTER)).toHaveLength(0);
  });

  it("does not fall back after content was already streamed", async () => {
    vastEnv();
    vi.stubEnv("INFERENCE_FALLBACK_ENABLED", "true");
    vi.stubEnv("INFERENCE_FALLBACK_PROVIDER", "openrouter");

    // Pull-based body: the first read delivers a frame, the next one fails, which is
    // what a machine dying mid-stream looks like on the wire.
    const encoder = new TextEncoder();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"par"}}]}\n\n'));
          return;
        }
        controller.error(new Error("socket hang up"));
      },
    });
    const { calls } = routeFetch({
      vast: () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      openrouter: openRouterOk,
    });

    const chunks = await collect(getInferenceProvider().stream(request));
    const failure = chunks.at(-1);
    expect(chunks[0]).toEqual({ type: "delta", text: "par" });
    expect(failure?.type === "error" ? failure.error.code : "").toBe("upstream");
    // The partial belongs to the primary; the fallback is never spliced in.
    expect(calls.filter((url) => url === OPENROUTER)).toHaveLength(0);
  });

  it("surfaces the original primary error when the fallback also fails", async () => {
    vastEnv();
    vi.stubEnv("INFERENCE_FALLBACK_ENABLED", "true");
    vi.stubEnv("INFERENCE_FALLBACK_PROVIDER", "openrouter");

    routeFetch({
      vast: () => new Response("boom", { status: 502 }),
      // A different failure shape from the primary's, to prove which one is reported.
      openrouter: () => new Response("busy", { status: 429 }),
    });

    const chunks = await collect(getInferenceProvider().stream(request));
    const failure = chunks.at(-1);
    // The primary's `upstream`, not the fallback's `rate_limited`.
    expect(failure?.type === "error" ? failure.error.code : "").toBe("upstream");
    expect(failure?.type === "error" ? failure.servedBy : "").toBe("vast");
  });

  it("never switches providers silently when failover is disabled", async () => {
    vastEnv();
    vi.stubEnv("INFERENCE_FALLBACK_ENABLED", "false");
    vi.stubEnv("INFERENCE_FALLBACK_PROVIDER", "openrouter");

    const { calls } = routeFetch({
      vast: () => new Response("upstream down", { status: 503 }),
      openrouter: openRouterOk,
    });

    const chunks = await collect(getInferenceProvider().stream(request));
    const failure = chunks.at(-1);
    expect(failure?.type === "error" ? failure.error.code : "").toBe("upstream");
    expect(failure?.type === "error" ? failure.error.retryable : false).toBe(true);
    // A healthy fallback exists but was not used: the operator never enabled it.
    expect(calls.filter((url) => url === OPENROUTER)).toHaveLength(0);
  });

  it("propagates cancellation instead of failing over", async () => {
    vastEnv();
    vi.stubEnv("INFERENCE_FALLBACK_ENABLED", "true");
    vi.stubEnv("INFERENCE_FALLBACK_PROVIDER", "openrouter");

    // The primary never answers; the caller aborts.
    const body = new ReadableStream<Uint8Array>({ start() { /* hold the connection open */ } });
    const { calls } = routeFetch({
      vast: () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      openrouter: openRouterOk,
    });

    const controller = new AbortController();
    const chunks: InferenceChunk[] = [];
    const iterate = (async () => {
      for await (const chunk of getInferenceProvider().stream({ ...request, operationKey: "op-cancel", signal: controller.signal })) {
        chunks.push(chunk);
      }
    })();
    // Abort shortly after the stream starts.
    setTimeout(() => controller.abort(), 20);
    await iterate;

    const failure = chunks.at(-1);
    expect(failure?.type === "error" ? failure.error.code : "").toBe("cancelled");
    expect(calls.filter((url) => url === OPENROUTER)).toHaveLength(0);
  }, 15_000);
});
