import { describe, expect, it } from "vitest";
import { parseBody } from "../../app/api/v1/chat/completions/route";

const message = { role: "user", content: "hello" };

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
});
