import { describe, expect, it } from "vitest";
import { parseBody, assertToolCapability } from "../../lib/server/chat-request";

const message = { role: "user", content: "hello" };
const tools = [{ type: "function", function: { name: "lookup", description: "Look something up", parameters: { type: "object", properties: { q: { type: "string" } } } } }];

describe("chat completion request contract", () => {
  it("accepts all supported parameters and leaves omitted fields absent", () => {
    const parsed = parseBody({ model: "curated-model", messages: [message], temperature: 0.25, top_p: 0.9, max_completion_tokens: 128 });
    expect("code" in parsed).toBe(false);
    if (!("code" in parsed)) expect(parsed.parameters).toEqual({ temperature: 0.25, top_p: 0.9, max_completion_tokens: 128 });
  });

  it.each([
    ["temperature", { temperature: "hot" }],
    ["top_p", { top_p: Number.NaN }],
    ["max_tokens", { max_tokens: 0 }],
    ["max_completion_tokens", { max_completion_tokens: 32769 }],
    ["both token limits", { max_tokens: 4, max_completion_tokens: 4 }],
  ])("rejects invalid %s", (_name, fields) => {
    const parsed = parseBody({ messages: [message], ...fields });
    expect("code" in parsed).toBe(true);
  });

  it("accepts valid tool definitions, tool_choice, and tool messages", () => {
    const parsed = parseBody({
      messages: [
        message,
        { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] },
        { role: "tool", content: "{\"ok\":true}", tool_call_id: "call_1" },
      ],
      tools,
      tool_choice: "auto",
    });
    expect("code" in parsed).toBe(false);
    if (!("code" in parsed)) {
      expect(parsed.tools).toEqual(tools);
      expect(parsed.toolChoice).toBe("auto");
      expect(parsed.messages[1].tool_calls).toHaveLength(1);
      expect(parsed.messages[2].tool_call_id).toBe("call_1");
    }
  });

  it("accepts a named tool_choice that references a declared tool", () => {
    const parsed = parseBody({ messages: [message], tools, tool_choice: { type: "function", function: { name: "lookup" } } });
    expect("code" in parsed).toBe(false);
  });

  it.each([
    ["unknown tool_choice name", { messages: [message], tools, tool_choice: { type: "function", function: { name: "missing" } } }],
    ["tool_choice without tools", { messages: [message], tool_choice: "auto" }],
    ["duplicate tool names", { messages: [message], tools: [tools[0], tools[0]] }],
    ["non-function tool entry", { messages: [message], tools: [{ type: "retrieval" }] }],
    ["tool message without tool_call_id", { messages: [{ role: "tool", content: "{}" }] }],
    ["tool_calls on a user message", { messages: [{ ...message, tool_calls: [{ id: "c", type: "function", function: { name: "lookup", arguments: "{}" } }] }] }],
    ["tool call with non-JSON arguments", { messages: [{ role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: "lookup", arguments: "nope" } }] }] }],
  ])("rejects malformed %s with a validation error", (_name, body) => {
    const parsed = parseBody(body);
    expect("code" in parsed).toBe(true);
    if ("code" in parsed) expect(["invalid_tools", "invalid_messages"]).toContain(parsed.code);
  });

  it("keeps the unsupported_capability refusal for a model without tools", () => {
    const parsed = parseBody({ messages: [message], tools, tool_choice: "auto" });
    if ("code" in parsed) throw new Error("expected a valid request");
    const refusal = assertToolCapability(parsed, false);
    expect(refusal?.code).toBe("unsupported_capability");
    expect(refusal?.status).toBe(400);
    expect(assertToolCapability(parsed, true)).toBeNull();
  });

  it("leaves a request without tools unaffected by the capability gate", () => {
    const parsed = parseBody({ messages: [message] });
    if ("code" in parsed) throw new Error("expected a valid request");
    expect(assertToolCapability(parsed, false)).toBeNull();
  });
});
