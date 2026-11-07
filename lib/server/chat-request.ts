/**
 * Public request contract for the OpenAI-compatible chat gateway.
 *
 * Tool calling is part of this contract, but it is never enabled unconditionally:
 * `parseBody` only proves that the tool fields are WELL FORMED. Whether the
 * selected model may receive them is decided afterwards by `assertToolCapability`
 * against the model's synced `supported_parameters`, which is the only source of
 * truth for provider capability. A model without `tools` therefore still gets the
 * original `unsupported_capability` refusal.
 */

export type PublicToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type PublicToolDefinition = { type: "function"; function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean } };
export type PublicToolChoice = "none" | "auto" | "required" | { type: "function"; function: { name: string } };

/**
 * `content` stays a plain string for every role so persistence and context
 * assembly are unchanged. An assistant message may carry the tool calls the model
 * asked for, and a `tool` message answers exactly one of those calls.
 */
export type PublicMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: PublicToolCall[];
  tool_call_id?: string;
};

export type CompletionParameters = { temperature?: number; top_p?: number; max_tokens?: number; max_completion_tokens?: number; seed?: number; stop?: string[] };
export type ChatRequestError = { code: string; message: string; status: number };

export type ChatRequest = {
  model: string;
  messages: PublicMessage[];
  stream: boolean;
  parameters: CompletionParameters;
  tools?: PublicToolDefinition[];
  toolChoice?: PublicToolChoice;
};

export type ToolOptions = { tools: PublicToolDefinition[]; toolChoice?: PublicToolChoice };

// Same bounds the existing contract already enforces: one message length cap and
// one message-count cap are reused rather than introducing new limits.
const MAX_MESSAGE_LENGTH = 32000;
const MAX_MESSAGES = 100;
const MAX_TOOL_DEFINITIONS = 128;
const MAX_TOOL_CALLS_PER_MESSAGE = 100;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_CHOICE_KEYWORDS = ["none", "auto", "required"] as const;

type Result<T> = { ok: true; value: T } | { ok: false; error: ChatRequestError };

function invalid(code: string, message: string, status = 400): { ok: false; error: ChatRequestError } { return { ok: false, error: error(code, message, status) }; }
function error(code: string, message: string, status: number): ChatRequestError { return { code, message, status }; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function parsedJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return {};
  try { const parsed: unknown = JSON.parse(raw); return isRecord(parsed) ? parsed : null; } catch { return null; }
}

/** Validates one assistant `tool_calls` array (history replay, or a client round-trip). */
function parseToolCalls(value: unknown): Result<PublicToolCall[]> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TOOL_CALLS_PER_MESSAGE) return invalid("invalid_messages", `tool_calls must contain between 1 and ${MAX_TOOL_CALLS_PER_MESSAGE} tool calls.`);
  const calls: PublicToolCall[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || entry.type !== "function") return invalid("invalid_messages", "Each tool call must be a function call.");
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id || id.length > 128 || ids.has(id)) return invalid("invalid_messages", "Each tool call needs a unique id of 128 characters or fewer.");
    const fn = entry.function;
    if (!isRecord(fn)) return invalid("invalid_messages", "Each tool call must name a function.");
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!TOOL_NAME_PATTERN.test(name)) return invalid("invalid_messages", "A tool call must name a function using 1-64 letters, digits, underscores or hyphens.");
    const args = fn.arguments;
    if (typeof args !== "string" || args.length > MAX_MESSAGE_LENGTH) return invalid("invalid_messages", "Tool call arguments must be a JSON string.");
    if (parsedJsonObject(args) === null) return invalid("invalid_messages", "Tool call arguments must be a JSON object.");
    ids.add(id);
    calls.push({ id, type: "function", function: { name, arguments: args } });
  }
  return { ok: true, value: calls };
}

/** Validates the declared tool definitions. Nothing is added or inferred here. */
function parseToolDefinitions(value: unknown): Result<PublicToolDefinition[]> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TOOL_DEFINITIONS) return invalid("invalid_tools", `tools must contain between 1 and ${MAX_TOOL_DEFINITIONS} function definitions.`);
  const definitions: PublicToolDefinition[] = [];
  const names = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || entry.type !== "function") return invalid("invalid_tools", "Each tool must be a function definition.");
    const fn = entry.function;
    if (!isRecord(fn)) return invalid("invalid_tools", "Each tool must declare a function.");
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!TOOL_NAME_PATTERN.test(name)) return invalid("invalid_tools", "A tool must declare a function name of 1-64 letters, digits, underscores or hyphens.");
    if (names.has(name)) return invalid("invalid_tools", `The tool ${name} is declared more than once.`);
    if (fn.description !== undefined && (typeof fn.description !== "string" || fn.description.length > 1024)) return invalid("invalid_tools", "A tool description must be a string of 1,024 characters or fewer.");
    if (fn.parameters !== undefined && !isRecord(fn.parameters)) return invalid("invalid_tools", "Tool parameters must be a JSON schema object.");
    if (fn.strict !== undefined && typeof fn.strict !== "boolean") return invalid("invalid_tools", "A tool strict flag must be a boolean.");
    const definition: PublicToolDefinition = { type: "function", function: { name } };
    if (typeof fn.description === "string") definition.function.description = fn.description;
    if (isRecord(fn.parameters)) definition.function.parameters = fn.parameters;
    if (typeof fn.strict === "boolean") definition.function.strict = fn.strict;
    names.add(name);
    definitions.push(definition);
  }
  return { ok: true, value: definitions };
}

function parseToolChoice(value: unknown, names: Set<string>): Result<PublicToolChoice | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value === "string") {
    if (!TOOL_CHOICE_KEYWORDS.includes(value as (typeof TOOL_CHOICE_KEYWORDS)[number])) return invalid("invalid_tools", "tool_choice must be one of none, auto, required, or a named function.");
    return { ok: true, value: value as PublicToolChoice };
  }
  if (!isRecord(value) || value.type !== "function") return invalid("invalid_tools", "tool_choice must be one of none, auto, required, or a named function.");
  const fn = value.function;
  if (!isRecord(fn) || typeof fn.name !== "string") return invalid("invalid_tools", "A named tool_choice must reference a function name.");
  const name = fn.name.trim();
  // An unknown name is a malformed tool schema, not an upstream failure: the
  // request can never be honoured, so it is refused before any provider work.
  if (!names.has(name)) return invalid("invalid_tools", `tool_choice references an unknown tool: ${name || "(empty)"}.`);
  return { ok: true, value: { type: "function", function: { name } } };
}

function parseMessages(value: unknown): Result<PublicMessage[]> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MESSAGES) return invalid("invalid_messages", `messages must contain between 1 and ${MAX_MESSAGES} items.`);
  const messages: PublicMessage[] = [];
  for (const item of value) {
    if (!isRecord(item) || !["system", "user", "assistant", "tool"].includes(String(item.role))) return invalid("invalid_messages", "Each message must have a supported role and non-empty text content.");
    const role = String(item.role) as PublicMessage["role"];
    const rawContent = item.content;
    if (rawContent !== undefined && rawContent !== null && typeof rawContent !== "string") return invalid("invalid_messages", "Each message must have a supported role and non-empty text content.");
    const content = typeof rawContent === "string" ? rawContent : "";
    if (content.length > MAX_MESSAGE_LENGTH) return invalid("invalid_messages", "Each message must have a supported role and non-empty text content.");
    const message: PublicMessage = { role, content };
    if (role === "tool") {
      if (item.tool_calls !== undefined) return invalid("invalid_messages", "A tool result message cannot carry tool calls.");
      const toolCallId = typeof item.tool_call_id === "string" ? item.tool_call_id.trim() : "";
      if (!toolCallId || toolCallId.length > 128) return invalid("invalid_messages", "A tool result message must reference the tool call it answers.");
      message.tool_call_id = toolCallId;
      messages.push(message);
      continue;
    }
    if (item.tool_call_id !== undefined) return invalid("invalid_messages", "Only a tool result message can reference a tool call.");
    if (item.tool_calls !== undefined) {
      if (role !== "assistant") return invalid("invalid_messages", "Only an assistant message can carry tool calls.");
      const calls = parseToolCalls(item.tool_calls);
      if (!calls.ok) return calls;
      message.tool_calls = calls.value;
    }
    // An assistant message that only requests tools legitimately has no text; every
    // other message still needs content, exactly as before.
    if (!content.trim() && !message.tool_calls?.length) return invalid("invalid_messages", "Each message must have a supported role and non-empty text content.");
    messages.push(message);
  }
  return { ok: true, value: messages };
}

/**
 * Parses the tool fields of a request. Exported so the workspace chat route can
 * accept the same declarations and validate them with the same rules.
 */
export function parseToolOptions(rawTools: unknown, rawToolChoice: unknown): Result<ToolOptions> {
  if (rawTools === undefined || rawTools === null) {
    // tool_choice without tools can never be honoured, so it is a validation error.
    if (rawToolChoice !== undefined && rawToolChoice !== null) return invalid("invalid_tools", "tool_choice requires at least one declared tool.");
    return { ok: true, value: { tools: [] } };
  }
  const definitions = parseToolDefinitions(rawTools);
  if (!definitions.ok) return definitions;
  const names = new Set(definitions.value.map((definition) => definition.function.name));
  const choice = parseToolChoice(rawToolChoice, names);
  if (!choice.ok) return choice;
  const options: ToolOptions = { tools: definitions.value };
  if (choice.value !== undefined) options.toolChoice = choice.value;
  return { ok: true, value: options };
}

/**
 * The single gate that decides whether tool fields may be forwarded. A model is
 * capable only when its synced provider metadata lists the `tools` parameter; a
 * request that uses tools against any other model keeps the original
 * `unsupported_capability` refusal.
 */
export function assertToolCapability(request: { messages: PublicMessage[]; tools?: PublicToolDefinition[]; toolChoice?: PublicToolChoice }, modelSupportsTools: boolean): ChatRequestError | null {
  const usesTools = Boolean(request.tools?.length) || request.toolChoice !== undefined || request.messages.some((message) => message.role === "tool" || Boolean(message.tool_calls?.length));
  if (!usesTools) return null;
  if (modelSupportsTools) return null;
  return error("unsupported_capability", "The tools capability is not supported by the selected model.", 400);
}

export function parseBody(raw: unknown): ChatRequest | ChatRequestError {
  if (!isRecord(raw)) return error("invalid_request", "The request body must be a JSON object.", 400);
  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : "auto";
  const messages = parseMessages(raw.messages);
  if (!messages.ok) return messages.error;
  if (raw.stream !== undefined && typeof raw.stream !== "boolean") return error("invalid_request", "stream must be a boolean.", 400);
  if (raw.stream_options !== undefined && (!isRecord(raw.stream_options) || raw.stream_options.include_usage !== true || Object.keys(raw.stream_options).some((key) => key !== "include_usage"))) return error("unsupported_capability", "The requested streaming options are not supported.", 400);
  if (raw.n !== undefined && raw.n !== 1) return error("unsupported_capability", "Only one completion per request is supported.", 400);
  for (const key of ["response_format", "user"]) if (raw[key] !== undefined) return error("unsupported_capability", `The ${key} capability is not supported by the public gateway contract.`, 400);
  const tools = parseToolOptions(raw.tools, raw.tool_choice);
  if (!tools.ok) return tools.error;
  for (const key of ["temperature", "top_p"]) if (raw[key] !== undefined && (typeof raw[key] !== "number" || !Number.isFinite(raw[key]) || Number(raw[key]) < 0 || Number(raw[key]) > 2)) return error("invalid_request", `${key} must be a finite number between 0 and 2.`, 400);
  if (raw.top_p !== undefined && Number(raw.top_p) > 1) return error("invalid_request", "top_p must be between 0 and 1.", 400);
  for (const key of ["max_tokens", "max_completion_tokens"]) if (raw[key] !== undefined && (!Number.isInteger(raw[key]) || Number(raw[key]) < 1 || Number(raw[key]) > 32768)) return error("invalid_request", `${key} must be an integer between 1 and 32768.`, 400);
  if (raw.seed !== undefined && (!Number.isInteger(raw.seed) || Number(raw.seed) < 0 || Number(raw.seed) > 2147483647)) return error("invalid_request", "seed must be an integer between 0 and 2147483647.", 400);
  if (raw.stop !== undefined && (!Array.isArray(raw.stop) || raw.stop.length > 4 || raw.stop.some((item) => typeof item !== "string" || !item.trim() || item.length > 128))) return error("invalid_request", "stop must contain up to four non-empty sequences of 128 characters or fewer.", 400);
  if (raw.max_tokens !== undefined && raw.max_completion_tokens !== undefined) return error("invalid_request", "Specify only one token limit.", 400);
  const parameters: CompletionParameters = {};
  if (typeof raw.temperature === "number") parameters.temperature = raw.temperature;
  if (typeof raw.top_p === "number") parameters.top_p = raw.top_p;
  if (typeof raw.max_tokens === "number") parameters.max_tokens = raw.max_tokens;
  if (typeof raw.max_completion_tokens === "number") parameters.max_completion_tokens = raw.max_completion_tokens;
  if (typeof raw.seed === "number") parameters.seed = raw.seed;
  if (Array.isArray(raw.stop)) parameters.stop = raw.stop as string[];
  const request: ChatRequest = { model, messages: messages.value, stream: raw.stream === true, parameters };
  if (tools.value.tools.length) request.tools = tools.value.tools;
  if (tools.value.toolChoice !== undefined) request.toolChoice = tools.value.toolChoice;
  return request;
}
