import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterProvider } from "../../lib/server/openrouter";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const sse = (events: unknown[]) => new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });

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
    expect(payload).not.toHaveProperty("tools");
    expect(payload).not.toHaveProperty("tool_choice");
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

  it("forwards tool definitions, tool_choice, and tool messages upstream", async () => {
    vi.stubEnv("OPENROUTER_ENABLED", "true");
    vi.stubEnv("OPENROUTER_API_KEY", "test-secret");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("data: [DONE]\n\n", { status: 200 }));
    const tools = [{ type: "function" as const, function: { name: "lookup", description: "d", parameters: { type: "object", properties: {} } } }];
    for await (const _chunk of new OpenRouterProvider().stream({
      operationKey: "op-tools",
      model: "model",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":1}" } }] },
        { role: "tool", content: "{\"ok\":true}", tool_call_id: "call_1" },
      ],
      tools,
      toolChoice: "auto",
    })) {}
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown> & { messages: Array<Record<string, unknown>> };
    expect(payload.tools).toEqual(tools);
    expect(payload.tool_choice).toBe("auto");
    expect(payload.messages[1].tool_calls).toEqual([{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":1}" } }]);
    expect(payload.messages[2].tool_call_id).toBe("call_1");
  });

  it("accumulates fragmented tool_call deltas by index and keeps content streaming intact", async () => {
    vi.stubEnv("OPENROUTER_ENABLED", "true");
    vi.stubEnv("OPENROUTER_API_KEY", "test-secret");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sse([
      { choices: [{ delta: { content: "Thinking" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "lookup", arguments: "{\"q\":" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"cats\"}" } }] } }] },
      { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 3, cost: 0.000002 } },
    ]));
    const chunks = [];
    for await (const chunk of new OpenRouterProvider().stream({ operationKey: "op-stream-tools", model: "model", messages: [{ role: "user", content: "hi" }] })) chunks.push(chunk);
    const text = chunks.filter((chunk) => chunk.type === "delta").map((chunk) => chunk.type === "delta" ? chunk.text : "").join("");
    const toolChunk = chunks.find((chunk) => chunk.type === "tool_calls");
    expect(text).toBe("Thinking");
    expect(toolChunk?.type === "tool_calls" ? toolChunk.toolCalls : []).toEqual([
      { id: "call_a", type: "function", function: { name: "lookup", arguments: "{\"q\":\"cats\"}" } },
    ]);
    // `complete` is still last so existing consumers that stop there are unaffected.
    expect(chunks.at(-1)?.type).toBe("complete");
  });

  it("never yields an incomplete or malformed tool call fragment", async () => {
    vi.stubEnv("OPENROUTER_ENABLED", "true");
    vi.stubEnv("OPENROUTER_API_KEY", "test-secret");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "lookup", arguments: "{\"q\":" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "lookup", arguments: "not-json" } }] } }] },
    ]));
    const chunks = [];
    for await (const chunk of new OpenRouterProvider().stream({ operationKey: "op-partial-tools", model: "model", messages: [{ role: "user", content: "hi" }] })) chunks.push(chunk);
    expect(chunks.some((chunk) => chunk.type === "tool_calls")).toBe(false);
    expect(chunks.at(-1)?.type).toBe("complete");
  });
});
