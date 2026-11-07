import { describe, expect, it } from "vitest";
import { TOOL_HANDLERS, executeDeclaredToolCalls, resolveToolHandler, serializeResult } from "../../lib/server/tool-handlers";

const context = { accountId: "00000000-0000-0000-0000-000000000000", conversationId: "11111111-1111-1111-1111-111111111111", operationKey: "op" };
const call = { id: "call_1", type: "function" as const, function: { name: "lookup", arguments: "{}" } };

describe("tool handler registry", () => {
  it("registers no tools, so nothing can be executed on a caller's behalf", () => {
    expect(TOOL_HANDLERS).toHaveLength(0);
    expect(resolveToolHandler("lookup")).toBeNull();
  });

  it("reports an undeclared or unhandled tool call as non-executable", async () => {
    expect(await executeDeclaredToolCalls([call], new Set(["lookup"]), context)).toEqual({ executable: false });
    expect(await executeDeclaredToolCalls([call], new Set(), context)).toEqual({ executable: false });
    expect(await executeDeclaredToolCalls([], new Set(["lookup"]), context)).toEqual({ executable: false });
  });

  it("serializes results as JSON and stays safe for unserializable values", () => {
    expect(serializeResult({ ok: true })).toBe('{"ok":true}');
    expect(serializeResult(undefined)).toBe("null");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(JSON.parse(serializeResult(circular))).toHaveProperty("error");
  });
});
