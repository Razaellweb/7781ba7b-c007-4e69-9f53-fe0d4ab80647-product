import { afterEach, describe, expect, it, vi } from "vitest";
import { VastAIProvider, estimateTokens, normalizedErrorForStatus, type VastInferenceSettings } from "../../lib/server/vast-inference";
import type { InferenceChunk } from "../../lib/server/inference";

const settings: VastInferenceSettings = {
  enabled: true,
  baseUrl: "http://vast-gpu.invalid:8000/v1",
  apiKey: "vast-service-secret",
  requestTimeoutMs: 5_000,
  idleTimeoutMs: 5_000,
  healthTimeoutMs: 1_000,
  tokensPerSecond: 40,
  pricing: { promptUsdPerToken: 0.15 / 1_000_000, completionUsdPerToken: 0.5 / 1_000_000 },
};

function sse(frames: string[]): Response {
  return new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(provider: VastAIProvider, request: Parameters<VastAIProvider["stream"]>[0]) {
  const chunks: InferenceChunk[] = [];
  for await (const chunk of provider.stream(request)) chunks.push(chunk);
  return chunks;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("VastAIProvider contract", () => {
  it("streams deltas and a terminal event carrying usage and finish reason", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ]));

    const chunks = await collect(new VastAIProvider({ settings }), {
      operationKey: "op-stream",
      model: "Qwen/Qwen2.5-7B-Instruct",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(chunks.filter((chunk) => chunk.type === "delta").map((chunk) => (chunk.type === "delta" ? chunk.text : ""))).toEqual(["Hel", "lo"]);
    const terminal = chunks.at(-1);
    expect(terminal?.type).toBe("complete");
    if (terminal?.type !== "complete") throw new Error("expected terminal event");
    expect(terminal.output).toBe("Hello");
    expect(terminal.finishReason).toBe("length");
    expect(terminal.usage.inputTokens).toBe(3);
    expect(terminal.usage.outputTokens).toBe(2);
    expect(terminal.usage.uncertain).toBe(false);
    // 3 prompt tokens @ $0.15/M + 2 completion tokens @ $0.50/M, in micro-USD.
    expect(terminal.usage.providerCostMicroUsd).toBe(1n);

    // The service key travels as a bearer header only, never in the URL.
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://vast-gpu.invalid:8000/v1/chat/completions");
    expect(String(url)).not.toContain("vast-service-secret");
    expect(JSON.stringify(init?.headers)).toContain("Bearer vast-service-secret");
  });

  it("emits zero usage and no cost for an empty completion", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sse(['data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":0}}\n\n', "data: [DONE]\n\n"]));
    const chunks = await collect(new VastAIProvider({ settings }), { operationKey: "op-empty", model: "m", messages: [{ role: "user", content: "" }] });
    const terminal = chunks.at(-1);
    if (terminal?.type !== "complete") throw new Error("expected terminal event");
    expect(terminal.output).toBe("");
    expect(terminal.usage.providerCostMicroUsd).toBe(0n);
  });

  it("estimates usage and flags it for reconciliation when the upstream omits it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sse(['data: {"choices":[{"delta":{"content":"abcdefgh"}}]}\n\n', "data: [DONE]\n\n"]));
    const chunks = await collect(new VastAIProvider({ settings }), { operationKey: "op-estimate", model: "m", messages: [{ role: "user", content: "abcd" }] });
    const terminal = chunks.at(-1);
    if (terminal?.type !== "complete") throw new Error("expected terminal event");
    expect(terminal.usage.uncertain).toBe(true);
    expect(terminal.usage.inputTokens).toBe(estimateTokens("abcd"));
    expect(terminal.usage.outputTokens).toBe(estimateTokens("abcdefgh"));
    expect(terminal.usage.providerCostMicroUsd).not.toBeNull();
  });

  it("skips malformed frames without crashing the stream", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sse([
      "data: {not json\n\n",
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      "data: [DONE]\n\n",
    ]));
    const chunks = await collect(new VastAIProvider({ settings }), { operationKey: "op-malformed", model: "m", messages: [{ role: "user", content: "x" }] });
    expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
    const terminal = chunks.at(-1);
    expect(terminal?.type === "complete" ? terminal.output : "").toBe("ok");
  });

  it("maps upstream status codes onto the normalized taxonomy", () => {
    expect(normalizedErrorForStatus(401).code).toBe("authentication");
    expect(normalizedErrorForStatus(403).code).toBe("authentication");
    expect(normalizedErrorForStatus(429).code).toBe("rate_limited");
    expect(normalizedErrorForStatus(429).retryable).toBe(true);
    expect(normalizedErrorForStatus(503).code).toBe("upstream");
    expect(normalizedErrorForStatus(404).code).toBe("unsupported_model");
    expect(normalizedErrorForStatus(504).code).toBe("timeout");
    expect(normalizedErrorForStatus(400).code).toBe("invalid_request");
  });

  it("surfaces an auth failure without retrying or leaking the key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("invalid key: vast-service-secret", { status: 401 }));
    const chunks = await collect(new VastAIProvider({ settings }), { operationKey: "op-auth", model: "m", messages: [{ role: "user", content: "x" }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const failure = chunks.find((chunk) => chunk.type === "error");
    expect(failure?.type === "error" ? failure.error.code : "").toBe("authentication");
    expect(JSON.stringify(chunks)).not.toContain("vast-service-secret");
  });

  it("reports health from /v1/models including latency and model ids", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "Qwen/Qwen2.5-7B-Instruct" }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const health = await new VastAIProvider({ settings }).health();
    expect(health.healthy).toBe(true);
    expect(health.status).toBe("operational");
    expect(health.modelIds).toEqual(["Qwen/Qwen2.5-7B-Instruct"]);
    expect(typeof health.latencyMs).toBe("number");
  });

  it("reports unavailable health when the endpoint cannot be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const health = await new VastAIProvider({ settings }).health();
    expect(health.healthy).toBe(false);
    expect(health.status).toBe("unavailable");
  });

  it("reports unavailable when the endpoint is not configured", async () => {
    const provider = new VastAIProvider({ settings: { enabled: false } });
    const health = await provider.health();
    expect(health.healthy).toBe(false);
    const chunks = await collect(provider, { operationKey: "op-unconfigured", model: "m", messages: [{ role: "user", content: "x" }] });
    const failure = chunks.find((chunk) => chunk.type === "error");
    expect(failure?.type === "error" ? failure.error.code : "").toBe("unavailable");
  });

  it("prices a completion from per-token pricing and GPU-hour economics", () => {
    const provider = new VastAIProvider({ settings });
    const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 };
    // Default rates: $0.15/M prompt + $0.50/M completion = 650_000 micro-USD.
    expect(provider.cost(usage)).toBe(650_000n);
    // Registry-style pricing overrides the defaults.
    expect(provider.cost(usage, { pricing: { prompt: "0.000001", completion: "0.000002" } })).toBe(3_000_000n);
    // GPU-hour derivation: $0.50/hr at 50 tokens/sec ⇒ ~$2.78/M tokens.
    const hourlyMicroUsd = 500_000n;
    const derived = provider.cost({ promptTokens: 0, completionTokens: 1_000_000, totalTokens: 1_000_000 }, { hourlyMicroUsd, tokensPerSecond: 50 });
    expect(derived).not.toBeNull();
    expect(derived! > 0n).toBe(true);
  });

  it("emits a cancelled terminal event when the caller aborts mid-stream", async () => {
    const encoder = new TextEncoder();
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        // Never closes on its own; the abort must tear it down.
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));

    const chunks: InferenceChunk[] = [];
    const provider = new VastAIProvider({ settings });
    const iterate = (async () => {
      for await (const chunk of provider.stream({
        operationKey: "op-cancel",
        model: "m",
        messages: [{ role: "user", content: "x" }],
        signal: controller.signal,
      })) {
        chunks.push(chunk);
        if (chunk.type === "delta") controller.abort();
      }
    })();

    await iterate;
    const failure = chunks.find((chunk) => chunk.type === "error");
    expect(failure?.type === "error" ? failure.error.code : "").toBe("cancelled");
  });

  it("treats an idle stall as a timeout", async () => {
    const body = new ReadableStream<Uint8Array>({ start() { /* never sends a frame */ } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));
    const provider = new VastAIProvider({ settings: { ...settings, idleTimeoutMs: 20 } });
    const chunks = await collect(provider, { operationKey: "op-idle", model: "m", messages: [{ role: "user", content: "x" }] });
    const failure = chunks.find((chunk) => chunk.type === "error");
    expect(failure?.type === "error" ? failure.error.code : "").toBe("timeout");
  });

  it("returns a normalized completion from complete()", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      model: "Qwen/Qwen2.5-7B-Instruct",
      choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const completion = await new VastAIProvider({ settings }).complete({ operationKey: "op-complete", model: "m", messages: [{ role: "user", content: "x" }] });
    expect(completion.output).toBe("done");
    expect(completion.finishReason).toBe("stop");
    expect(completion.error).toBeUndefined();
    expect(completion.usage.inputTokens).toBe(1);
  });

  it("returns a normalized error from complete() on upstream 5xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 502 }));
    const completion = await new VastAIProvider({ settings }).complete({ operationKey: "op-5xx", model: "m", messages: [{ role: "user", content: "x" }] });
    expect(completion.error?.code).toBe("upstream");
    expect(completion.usage.providerCostMicroUsd).toBe(0n);
  });
});
