export type PublicMessage = { role: "system" | "user" | "assistant"; content: string };
export type CompletionParameters = { temperature?: number; top_p?: number; max_tokens?: number; max_completion_tokens?: number };
export type ChatRequestError = { code: string; message: string; status: number };

type ChatRequest = { model: string; messages: PublicMessage[]; stream: boolean; parameters: CompletionParameters };

function error(code: string, message: string, status: number): ChatRequestError {
  return { code, message, status };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseBody(raw: unknown): ChatRequest | ChatRequestError {
  if (!isRecord(raw)) return error("invalid_request", "The request body must be a JSON object.", 400);
  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : "auto";
  if (!Array.isArray(raw.messages) || raw.messages.length < 1 || raw.messages.length > 100) return error("invalid_messages", "messages must contain between 1 and 100 items.", 400);
  const messages: PublicMessage[] = [];
  for (const item of raw.messages) {
    if (!isRecord(item) || !["system", "user", "assistant"].includes(String(item.role)) || typeof item.content !== "string" || !item.content.trim() || item.content.length > 32000) return error("invalid_messages", "Each message must have a supported role and non-empty text content.", 400);
    messages.push({ role: item.role as PublicMessage["role"], content: item.content });
  }
  if (raw.stream !== undefined && typeof raw.stream !== "boolean") return error("invalid_request", "stream must be a boolean.", 400);
  if (raw.stream_options !== undefined && (!isRecord(raw.stream_options) || raw.stream_options.include_usage !== true || Object.keys(raw.stream_options).some((key) => key !== "include_usage"))) return error("unsupported_capability", "The requested streaming options are not supported.", 400);
  if (raw.n !== undefined && raw.n !== 1) return error("unsupported_capability", "Only one completion per request is supported.", 400);
  for (const key of ["tools", "tool_choice", "response_format", "stop", "user"]) if (raw[key] !== undefined) return error("unsupported_capability", `The ${key} capability is not supported by the public gateway contract.`, 400);
  for (const key of ["temperature", "top_p"]) if (raw[key] !== undefined && (typeof raw[key] !== "number" || !Number.isFinite(raw[key]))) return error("invalid_request", `${key} must be a finite number.`, 400);
  for (const key of ["max_tokens", "max_completion_tokens"]) if (raw[key] !== undefined && (!Number.isInteger(raw[key]) || Number(raw[key]) < 1 || Number(raw[key]) > 32768)) return error("invalid_request", `${key} must be an integer between 1 and 32768.`, 400);
  if (raw.max_tokens !== undefined && raw.max_completion_tokens !== undefined) return error("invalid_request", "Specify only one token limit.", 400);
  const parameters: CompletionParameters = {};
  if (typeof raw.temperature === "number") parameters.temperature = raw.temperature;
  if (typeof raw.top_p === "number") parameters.top_p = raw.top_p;
  if (typeof raw.max_tokens === "number") parameters.max_tokens = raw.max_tokens;
  if (typeof raw.max_completion_tokens === "number") parameters.max_completion_tokens = raw.max_completion_tokens;
  return { model, messages, stream: raw.stream === true, parameters };
}
