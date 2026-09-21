import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterProvider } from "../../lib/server/openrouter";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("OpenRouter provider boundary", () => {
  it("forwards every accepted completion parameter and preserves omitted defaults", async () => {
    vi.stubEnv("OPENROUTER_ENABLED", "true");
    vi.stubEnv("OPENROUTER_API_KEY", "test-secret");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"cost":0.000001}}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));

    const chunks = [];
    for await (const chunk of new OpenRouterProvider().stream({
      operationKey: "op-parameters",
      model: "upstream/model-slug",
      messages: [{ role: "user", content: "hello" }],
      parameters: { temperature: 0.2, top_p: 0.8, max_tokens: 64 },
    })) chunks.push(chunk);

    const request = fetchMock.mock.calls[0]?.[1];
    const payload = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(payload.temperature).toBe(0.2);
    expect(payload.top_p).toBe(0.8);
    expect(payload.max_tokens).toBe(64);
    expect(payload).not.toHaveProperty("max_completion_tokens");
    expect(chunks.some((chunk) => chunk.type === "complete")).toBe(true);
    expect(String(request?.headers)).not.toContain("test-secret");
  });

  it("supports max_completion_tokens without sending both token-limit fields", async () => {
    vi.stubEnv("OPENROUTER_ENABLED", "true");
    vi.stubEnv("OPENROUTER_API_KEY", "test-secret");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("data: [DONE]\n\n", { status: 200 }));
    for await (const _chunk of new OpenRouterProvider().stream({ operationKey: "op-limit", model: "model", messages: [{ role: "user", content: "x" }], parameters: { max_completion_tokens: 128 } })) {}
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(payload.max_completion_tokens).toBe(128);
    expect(payload).not.toHaveProperty("max_tokens");
  });

  it("normalizes timeout and upstream failures without exposing provider details", async () => {
    vi.stubEnv("OPENROUTER_ENABLED", "true");
    vi.stubEnv("OPENROUTER_API_KEY", "provider-secret");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream private body", { status: 504 }));
    const chunks = [];
    for await (const chunk of new OpenRouterProvider().stream({ operationKey: "op-timeout", model: "model", messages: [{ role: "user", content: "secret generated content" }] })) chunks.push(chunk);
    const failure = chunks.find((chunk) => chunk.type === "error");
    expect(failure?.type === "error" ? failure.error.code : "").toBe("timeout");
    expect(JSON.stringify(failure)).not.toContain("provider-secret");
    expect(JSON.stringify(failure)).not.toContain("secret generated content");
  });
});
