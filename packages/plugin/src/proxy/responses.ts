import type { ChatRequest } from "./router.js";

type JsonObject = Record<string, unknown>;

function asRecord(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function nonemptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Encode function-call arguments as a JSON object string. Objects from NIM/Ollama are not dropped. */
export function argumentsText(value: unknown): string {
  if (value == null || value === "") return "{}";
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || "{}";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

export type SanitizedToolCall = { name: string; arguments: string };

/** Required field → safe default for explore tools a weak model calls empty. */
const REQUIRED_ARG_DEFAULTS: Record<string, [field: string, fallback: string]> = {
  glob: ["pattern", "*"],
  list: ["path", "."],
  bash: ["command", "ls -la"],
  shell: ["command", "ls -la"],
};

function parseArgumentsObject(text: string): JsonObject {
  if (!text || text === "{}") return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
  } catch {
    return {};
  }
}

/**
 * Weak models emit glob/read/bash with no required fields. OpenCode aborts those
 * calls and the model retries forever. Fill explore defaults. Empty `read` becomes
 * `glob *` — Read of "." is a directory and OpenCode aborts it too.
 */
export function sanitizeToolCall(name: string, raw: unknown): SanitizedToolCall | null {
  const tool = name.trim();
  if (!tool) return null;
  const lowered = tool.toLowerCase();
  const text = argumentsText(raw);
  const parsed = parseArgumentsObject(text);
  const withArgs = (): SanitizedToolCall => ({ name: tool, arguments: JSON.stringify(parsed) });

  const required = REQUIRED_ARG_DEFAULTS[lowered];
  if (required) {
    const [field, fallback] = required;
    if (!nonemptyString(parsed[field])) parsed[field] = fallback;
    return withArgs();
  }
  if (lowered === "read") {
    const path = nonemptyString(parsed.filePath) || nonemptyString(parsed.path);
    if (!path) return { name: "glob", arguments: JSON.stringify({ pattern: "*" }) };
    parsed.filePath = path;
    return withArgs();
  }
  if (lowered === "grep") return nonemptyString(parsed.pattern) ? withArgs() : null;
  return { name: tool, arguments: text || "{}" };
}

/** @deprecated use sanitizeToolCall — kept for existing tests. */
export function sanitizeToolCallArguments(name: string, raw: string): string | null {
  return sanitizeToolCall(name, raw)?.arguments ?? null;
}

function flattenContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content ?? "";
  const parts: unknown[] = [];
  let textOnly = true;
  let text = "";
  for (const part of content) {
    if (typeof part === "string") {
      text += part;
      parts.push({ type: "text", text: part });
      continue;
    }
    const rec = asRecord(part);
    const type = rec.type;
    if (type === "input_text" || type === "output_text" || type === "text") {
      const chunk = typeof rec.text === "string" ? rec.text : "";
      text += chunk;
      parts.push({ type: "text", text: chunk });
      continue;
    }
    if (type === "input_image" || type === "image_url") {
      textOnly = false;
      const image = rec.image_url;
      const url =
        typeof image === "string"
          ? image
          : typeof asRecord(image).url === "string"
            ? String(asRecord(image).url)
            : typeof rec.image === "string"
              ? rec.image
              : "";
      if (url) parts.push({ type: "image_url", image_url: { url } });
    }
  }
  return textOnly ? text : parts;
}

function contentToText(content: unknown): string {
  const flat = flattenContent(content);
  return typeof flat === "string" ? flat : "";
}

function toolParameters(rec: JsonObject, nested?: JsonObject): unknown {
  return (
    nested?.parameters ?? nested?.input_schema ?? rec.parameters ?? rec.input_schema ?? undefined
  );
}

/** OpenCode tools the empty-call death spiral hits first. Used only when the schema has no properties. */
const TOOL_PARAMETER_FALLBACKS: Record<string, JsonObject> = {
  bash: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run" },
      workdir: { type: "string", description: "Working directory" },
      timeout: { type: "number", description: "Timeout in milliseconds" },
    },
    required: ["command"],
  },
  read: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Absolute path of the file to read" },
      offset: { type: "number", description: "1-indexed start line" },
      limit: { type: "number", description: "Max lines to read" },
    },
    required: ["filePath"],
  },
  glob: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. **/*.md" },
      path: { type: "string", description: "Directory to search" },
    },
    required: ["pattern"],
  },
  grep: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Search string or regex" },
      path: { type: "string", description: "File or directory" },
      glob: { type: "string" },
    },
    required: ["pattern"],
  },
  list: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to list" },
    },
    required: ["path"],
  },
  foc_status: {
    type: "object",
    properties: {
      verbose: { type: "boolean", description: "Include fallbacks" },
    },
  },
  foc_models: {
    type: "object",
    properties: {
      refresh: { type: "boolean", description: "Re-probe providers" },
    },
  },
};

const PASSIVE_TOOL_TYPES = new Set([
  "computer",
  "file_search",
  "image_generation",
  "local_shell",
  "mcp",
  "tool_search",
  "web_search",
  "web_search_preview",
]);

function stripSchemaMeta(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSchemaMeta);
  if (value === null || typeof value !== "object") return value;
  const out: JsonObject = {};
  for (const [key, nested] of Object.entries(value as JsonObject)) {
    if (key === "$schema" || key === "$id" || key === "$defs" || key === "definitions") continue;
    out[key] = stripSchemaMeta(nested);
  }
  return out;
}

function schemaHasProperties(schema: unknown): boolean {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return false;
  const props = (schema as JsonObject).properties;
  return Boolean(
    props && typeof props === "object" && !Array.isArray(props) && Object.keys(props).length > 0
  );
}

function normalizeParameters(name: string, raw: unknown): JsonObject {
  const stripped = stripSchemaMeta(raw);
  if (!schemaHasProperties(stripped) && TOOL_PARAMETER_FALLBACKS[name]) {
    return TOOL_PARAMETER_FALLBACKS[name];
  }
  if (!schemaHasProperties(stripped)) {
    return { type: "object", properties: {} };
  }
  const rec = stripped as JsonObject;
  if (!rec.type) rec.type = "object";
  return rec;
}

function customToolFunction(name: string, description: string): JsonObject {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "Free-form input for the custom tool." },
        },
        required: ["input"],
      },
    },
  };
}

function normalizeOneTool(tool: unknown, namespace?: string): JsonObject | null {
  const rec = asRecord(tool);
  const toolType = typeof rec.type === "string" ? rec.type : "";
  if (toolType && PASSIVE_TOOL_TYPES.has(toolType)) return null;

  if (toolType === "custom") {
    const source = rec.custom && typeof rec.custom === "object" ? asRecord(rec.custom) : rec;
    const name = typeof source.name === "string" ? source.name : "";
    if (!name.trim()) return null;
    const desc = typeof source.description === "string" ? source.description : "";
    return customToolFunction(namespace ? `${namespace}__${name}` : name, desc);
  }

  let name = "";
  let description: unknown;
  let parameters: unknown;
  if (rec.function && typeof rec.function === "object") {
    const fn = asRecord(rec.function);
    name = typeof fn.name === "string" ? fn.name : typeof rec.name === "string" ? rec.name : "";
    description = fn.description ?? rec.description;
    parameters = toolParameters(rec, fn);
  } else if (typeof rec.name === "string") {
    name = rec.name;
    description = rec.description;
    parameters = toolParameters(rec);
  }
  if (!name.trim()) return null;
  const wireName = namespace ? `${namespace}__${name}` : name;
  return {
    type: "function",
    function: {
      name: wireName,
      description: typeof description === "string" ? description : "",
      parameters: normalizeParameters(name, parameters),
    },
  };
}

/** Chat Completions tools OpenAI-compat servers (SGLang, Ollama, vLLM) will actually honor. */
export function normalizeChatTools(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: unknown[] = [];
  const names = new Set<string>();
  const push = (normalized: JsonObject | null): void => {
    if (!normalized) return;
    const fn = asRecord(normalized.function);
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name || names.has(name)) return;
    names.add(name);
    out.push(normalized);
  };
  for (const tool of tools) {
    const rec = asRecord(tool);
    if (rec.type === "namespace") {
      const namespace = typeof rec.name === "string" ? rec.name : "";
      const nested = rec.tools;
      if (!Array.isArray(nested)) continue;
      for (const child of nested) push(normalizeOneTool(child, namespace || undefined));
      continue;
    }
    push(normalizeOneTool(tool));
  }
  if (out.length === 0 && tools.length > 0) return tools;
  return out;
}

function responsesToolChoiceToChat(choice: unknown): unknown {
  if (choice == null || choice === "auto") return "auto";
  if (choice === "none") return undefined;
  if (choice === "required") return "required";
  const rec = asRecord(choice);
  if (rec.type === "function" && typeof rec.name === "string" && !rec.function) {
    return { type: "function", function: { name: rec.name } };
  }
  if ((rec.type === "custom" || rec.type === "tool") && typeof rec.name === "string") {
    return { type: "function", function: { name: rec.name } };
  }
  if (rec.type === "any") return "required";
  return choice;
}

function callIdFromItem(rec: JsonObject, fallback: string): string {
  if (typeof rec.call_id === "string" && rec.call_id.trim()) return rec.call_id;
  if (typeof rec.id === "string" && rec.id.trim()) return rec.id;
  return fallback;
}

/**
 * Pull JSON/XML tool dumps out of assistant text. Weak models write these when
 * Chat Completions tool_calls never round-trip.
 */
export function extractToolCallsFromText(text: string): {
  calls: SanitizedToolCall[];
  text: string;
} {
  if (!text.trim()) return { calls: [], text };
  const calls: SanitizedToolCall[] = [];
  let remainder = text;

  const take = (name: string, args: unknown): void => {
    const sanitized = sanitizeToolCall(name, args);
    if (sanitized) calls.push(sanitized);
  };

  remainder = remainder.replace(
    /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi,
    (_all, body: string) => {
      const inner = String(body).trim();
      try {
        const parsed: unknown = JSON.parse(inner);
        const rec = asRecord(parsed);
        const name = typeof rec.name === "string" ? rec.name : "";
        if (name) {
          take(name, rec.arguments ?? rec.parameters ?? rec.input ?? rec);
          return "";
        }
      } catch {
        const named = /^([A-Za-z0-9_.-]+)\s*([\s\S]*)$/.exec(inner);
        if (named) {
          const jsonMatch = named[2].match(/\{[\s\S]*\}/);
          take(named[1], jsonMatch ? jsonMatch[0] : "{}");
          return "";
        }
      }
      return "";
    }
  );

  remainder = remainder.replace(
    /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/gi,
    (_all, name: string, body: string) => {
      const args: JsonObject = {};
      const paramRe = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/gi;
      for (const match of body.matchAll(paramRe)) {
        args[match[1]] = match[2].trim();
      }
      take(name, args);
      return "";
    }
  );

  remainder = remainder.replace(/\s+$/g, "");
  return { calls, text: remainder };
}

function reasoningInputText(rec: JsonObject): string {
  if (typeof rec.content === "string") return rec.content;
  if (!Array.isArray(rec.summary)) return "";
  return rec.summary
    .map((part) => asRecord(part).text)
    .filter((text): text is string => typeof text === "string")
    .join("");
}

/**
 * Consecutive `function_call` items become one
 * assistant message with `tool_calls`. OpenAI Chat rejects a tool result that
 * does not immediately follow the assistant turn that declared it.
 */
export function inputToMessages(input: unknown): Array<Record<string, unknown>> {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }
  if (!Array.isArray(input)) return [];
  const messages: Array<Record<string, unknown>> = [];
  let pendingReasoning = "";

  const lastToolCallMessage = (): Record<string, unknown> | null => {
    const last = messages[messages.length - 1];
    if (last && last.role === "assistant" && Array.isArray(last.tool_calls)) return last;
    return null;
  };

  /** Reasoning items attach to the next assistant turn, as Chat's `reasoning_content`. */
  const withPendingReasoning = (message: Record<string, unknown>): Record<string, unknown> => {
    if (pendingReasoning) {
      message.reasoning_content = pendingReasoning;
      pendingReasoning = "";
    }
    return message;
  };

  const addToolCall = (name: string, callId: string, args: unknown): void => {
    let message = lastToolCallMessage();
    if (!message) {
      message = withPendingReasoning({ role: "assistant", content: "", tool_calls: [] });
      messages.push(message);
    }
    const calls = message.tool_calls as Array<Record<string, unknown>>;
    calls.push({
      id: callId,
      type: "function",
      function: { name, arguments: argumentsText(args) },
    });
  };

  for (const [index, item] of input.entries()) {
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }
    const rec = asRecord(item);
    const type = rec.type;
    const role = typeof rec.role === "string" ? rec.role : "user";

    if (type === "reasoning") {
      pendingReasoning += reasoningInputText(rec);
      continue;
    }

    if (type === "function_call_output" || type === "custom_tool_call_output") {
      const output = rec.output;
      messages.push({
        role: "tool",
        tool_call_id: callIdFromItem(rec, `call_${index}`),
        content: typeof output === "string" ? output : JSON.stringify(output ?? ""),
      });
      continue;
    }

    if (type === "function_call" || type === "custom_tool_call") {
      const name = typeof rec.name === "string" ? rec.name : "";
      const args =
        type === "custom_tool_call" ? { input: rec.input ?? "" } : (rec.arguments ?? "{}");
      addToolCall(name, callIdFromItem(rec, `call_${index}`), args);
      continue;
    }

    if (role === "developer" || role === "system") {
      const text = contentToText(rec.content ?? rec.text);
      if (text) messages.push({ role: "system", content: text });
      continue;
    }

    if (role === "assistant") {
      const existing = lastToolCallMessage();
      const text = contentToText(rec.content ?? rec.text);
      if (existing) {
        // Keep Chat valid: do not insert assistant text between tool_calls and tool results.
        if (text && !String(existing.content ?? "").trim()) existing.content = text;
        continue;
      }
      const content = flattenContent(rec.content ?? rec.text);
      if (content === "" || content == null) continue;
      messages.push(withPendingReasoning({ role, content }));
      continue;
    }

    const content = flattenContent(rec.content ?? rec.text);
    if (content === "" || content == null) continue;
    messages.push({ role, content });
  }

  if (pendingReasoning) {
    messages.push({ role: "assistant", content: "", reasoning_content: pendingReasoning });
  }
  return messages;
}

export function responsesBodyToChat(body: Record<string, unknown>): ChatRequest {
  let messages = Array.isArray(body.messages)
    ? (body.messages as Array<Record<string, unknown>>)
    : inputToMessages(body.input);
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages = [{ role: "system", content: body.instructions }, ...messages];
  }
  const maxTokens =
    typeof body.max_output_tokens === "number"
      ? body.max_output_tokens
      : typeof body.max_tokens === "number"
        ? body.max_tokens
        : undefined;
  const chat: ChatRequest = {
    model: String(body.model ?? ""),
    messages,
    stream: body.stream !== false,
  };
  if (typeof body.temperature === "number") chat.temperature = body.temperature;
  if (typeof body.top_p === "number") chat.top_p = body.top_p;
  if (maxTokens !== undefined) chat.max_tokens = maxTokens;
  const tools = normalizeChatTools(body.tools);
  if (tools) {
    chat.tools = tools;
    if (body.tool_choice === undefined) chat.tool_choice = "auto";
  }
  if (body.tool_choice !== undefined) {
    const choice = responsesToolChoiceToChat(body.tool_choice);
    if (choice !== undefined) chat.tool_choice = choice;
  }
  if (body.parallel_tool_calls !== undefined) chat.parallel_tool_calls = body.parallel_tool_calls;
  const reasoning = asRecord(body.reasoning);
  if (Object.keys(reasoning).length > 0) chat.reasoning = body.reasoning;
  if (typeof reasoning.effort === "string") chat.reasoning_effort = reasoning.effort;
  return chat;
}

function sse(event: string, data: unknown, sequence: { n: number }): string {
  const payload =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? { ...(data as JsonObject), sequence_number: sequence.n++ }
      : data;
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

type FunctionCallItem = {
  id: string;
  call_id: string;
  name: string;
  arguments: string;
};

function messageItem(id: string, text: string): JsonObject {
  return {
    type: "message",
    id: `${id}_msg`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  };
}

function functionCallItem(call: FunctionCallItem, status: "in_progress" | "completed"): JsonObject {
  return {
    type: "function_call",
    id: call.id,
    call_id: call.call_id,
    name: call.name,
    arguments: status === "in_progress" ? "" : call.arguments,
    status,
  };
}

function reasoningItem(id: string, text: string): JsonObject {
  return {
    type: "reasoning",
    id: `${id}_reasoning`,
    summary: text ? [{ type: "summary_text", text }] : [],
  };
}

function collectRawToolCalls(message: JsonObject): Array<{
  id: string;
  name: string;
  arguments: unknown;
}> {
  const raw = message.tool_calls;
  const out: Array<{ id: string; name: string; arguments: unknown }> = [];
  if (Array.isArray(raw)) {
    for (const [index, item] of raw.entries()) {
      const rec = asRecord(item);
      const fn = rec.function && typeof rec.function === "object" ? asRecord(rec.function) : rec;
      const name =
        typeof fn.name === "string" ? fn.name : typeof rec.name === "string" ? rec.name : "";
      out.push({
        id: typeof rec.id === "string" && rec.id ? rec.id : `call_${index}`,
        name,
        arguments: fn.arguments ?? rec.arguments ?? rec.input ?? "{}",
      });
    }
  }
  const legacy = message.function_call;
  if (legacy && typeof legacy === "object") {
    const fn = asRecord(legacy);
    if (typeof fn.name === "string") {
      out.push({
        id: "call_legacy",
        name: fn.name,
        arguments: fn.arguments ?? "{}",
      });
    }
  }
  return out;
}

function collectToolCalls(message: JsonObject, extraText = ""): FunctionCallItem[] {
  const raw = collectRawToolCalls(message);
  const out: FunctionCallItem[] = [];
  for (const item of raw) {
    const sanitized = sanitizeToolCall(item.name, item.arguments);
    if (!sanitized) continue;
    out.push({
      id: `fc_${item.id}`,
      call_id: item.id,
      name: sanitized.name,
      arguments: sanitized.arguments,
    });
  }
  if (out.length === 0 && extraText) {
    const extracted = extractToolCallsFromText(extraText);
    for (const [index, call] of extracted.calls.entries()) {
      const callId = `call_text_${index}`;
      out.push({
        id: `fc_${callId}`,
        call_id: callId,
        name: call.name,
        arguments: call.arguments,
      });
    }
  }
  return out;
}

function assistantText(message: JsonObject): string {
  return contentToText(message.content);
}

function assistantReasoning(message: JsonObject): string {
  if (typeof message.reasoning_content === "string") return message.reasoning_content;
  if (typeof message.reasoning === "string") return message.reasoning;
  return "";
}

export function chatJsonToResponses(
  chat: Record<string, unknown>,
  publicModel: string
): Record<string, unknown> {
  const id =
    typeof chat.id === "string" ? chat.id.replace(/^chatcmpl/, "resp") : `resp_${Date.now()}`;
  const choices = Array.isArray(chat.choices) ? chat.choices : [];
  const first = asRecord(choices[0]);
  const message = asRecord(first.message);
  const rawText = assistantText(message);
  const extracted = extractToolCallsFromText(rawText);
  const text = extracted.text;
  const reasoning = assistantReasoning(message);
  const calls = collectToolCalls(message, rawText);
  const output: JsonObject[] = [];
  if (reasoning) output.push(reasoningItem(id, reasoning));
  for (const call of calls) output.push(functionCallItem(call, "completed"));
  if (text || calls.length === 0) output.push(messageItem(id, text));
  return {
    id,
    object: "response",
    status: "completed",
    model: publicModel,
    output,
    usage: chat.usage ?? {},
  };
}

type ToolAccum = FunctionCallItem & { outputIndex: number };

type StreamDelta = {
  content?: unknown;
  reasoning_content?: string;
  reasoning?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    name?: string;
    arguments?: unknown;
    function?: { name?: string; arguments?: unknown };
  }>;
  function_call?: { name?: string; arguments?: unknown };
};

type ChatChunk = { choices?: Array<{ delta?: StreamDelta; message?: JsonObject }> };

type ToolPatch = { call_id?: string; name?: string; arguments?: unknown };

function appendArguments(current: string, next: unknown): string {
  if (next == null) return current;
  if (typeof next === "object") return JSON.stringify(next);
  return current + String(next);
}

function assistantTextFromDelta(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return contentToText(content);
  return "";
}

/** One Chat Completions SSE line → parsed chunk; null for comments, `[DONE]`, and junk. */
function parseChatSseLine(line: string): ChatChunk | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as ChatChunk;
  } catch {
    return null;
  }
}

/**
 * Chat Completions deltas → Responses API SSE events. Reasoning and text stream
 * live; tool calls are buffered and emitted at the end, after sanitizing,
 * because weak models stream partial or empty arguments.
 */
class ResponsesStreamTranslator {
  private readonly sequence = { n: 0 };
  private nextOutputIndex = 0;
  private text = "";
  private reasoning = "";
  private reasoningIndex: number | null = null;
  private messageIndex: number | null = null;
  private textPartAdded = false;
  private readonly tools = new Map<number, ToolAccum>();

  constructor(
    private readonly responseId: string,
    private readonly publicModel: string
  ) {}

  private get messageId(): string {
    return `${this.responseId}_msg`;
  }

  private get reasoningId(): string {
    return `${this.responseId}_reasoning`;
  }

  private event(type: string, fields: JsonObject): string {
    return sse(type, { type, ...fields }, this.sequence);
  }

  start(): string[] {
    const response = {
      id: this.responseId,
      object: "response",
      status: "in_progress",
      model: this.publicModel,
      output: [],
    };
    return [
      this.event("response.created", { response }),
      this.event("response.in_progress", { response }),
    ];
  }

  ingestChunk(chunk: ChatChunk): string[] {
    const choice = chunk.choices?.[0];
    if (choice?.message) this.ingestMessageToolCalls(asRecord(choice.message));
    const delta = choice?.delta;
    if (!delta) return [];
    const out: string[] = [];
    const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
    if (reasoningDelta) out.push(...this.reasoningDelta(reasoningDelta));
    const contentDelta = assistantTextFromDelta(delta.content);
    if (contentDelta) out.push(...this.textDelta(contentDelta));
    if (delta.function_call) {
      this.ingestToolDelta(0, {
        name: delta.function_call.name,
        arguments: delta.function_call.arguments,
      });
    }
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const fn = call.function ?? call;
      this.ingestToolDelta(typeof call.index === "number" ? call.index : 0, {
        call_id: call.id,
        name: fn.name ?? call.name,
        arguments: fn.arguments ?? call.arguments,
      });
    }
    return out;
  }

  /** Some servers ignore `stream` and answer with one JSON body (no trailing newline). */
  ingestTrailingJson(leftover: string): void {
    if (!leftover.trim().startsWith("{")) return;
    try {
      const choice = (JSON.parse(leftover) as ChatChunk).choices?.[0];
      if (choice?.message) this.ingestMessageToolCalls(asRecord(choice.message));
    } catch {
      // leftover was not a full chat completion
    }
  }

  finish(): string[] {
    const out = this.finishReasoning();
    this.adoptToolCallsFromText();
    const tools = this.sanitizedTools();
    for (const tool of tools) out.push(...this.toolEvents(tool));
    out.push(...this.finishMessage());
    out.push(this.event("response.completed", { response: this.completedResponse(tools) }));
    return out;
  }

  private reasoningDelta(delta: string): string[] {
    const out: string[] = [];
    this.reasoning += delta;
    if (this.reasoningIndex === null) {
      this.reasoningIndex = this.nextOutputIndex++;
      out.push(
        this.event("response.output_item.added", {
          output_index: this.reasoningIndex,
          item: reasoningItem(this.responseId, ""),
        })
      );
    }
    out.push(
      this.event("response.reasoning_text.delta", {
        item_id: this.reasoningId,
        output_index: this.reasoningIndex,
        delta,
      })
    );
    return out;
  }

  private textDelta(delta: string): string[] {
    const out: string[] = [];
    this.text += delta;
    if (this.messageIndex === null) {
      this.messageIndex = this.nextOutputIndex++;
      out.push(
        this.event("response.output_item.added", {
          output_index: this.messageIndex,
          item: {
            type: "message",
            id: this.messageId,
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        })
      );
    }
    if (!this.textPartAdded) {
      this.textPartAdded = true;
      out.push(
        this.event("response.content_part.added", {
          output_index: this.messageIndex,
          content_index: 0,
          item_id: this.messageId,
          part: { type: "output_text", text: "" },
        })
      );
    }
    out.push(
      this.event("response.output_text.delta", {
        item_id: this.messageId,
        output_index: this.messageIndex,
        content_index: 0,
        delta,
      })
    );
    return out;
  }

  private ingestToolDelta(index: number, patch: ToolPatch): void {
    let tool = this.tools.get(index);
    if (!tool) {
      const callId = patch.call_id || `call_${index}`;
      tool = {
        id: `fc_${callId}`,
        call_id: callId,
        name: patch.name || "",
        arguments: "",
        outputIndex: this.nextOutputIndex++,
      };
      this.tools.set(index, tool);
    }
    if (patch.call_id) {
      tool.call_id = patch.call_id;
      tool.id = `fc_${patch.call_id}`;
    }
    if (patch.name) tool.name = patch.name;
    if (patch.arguments !== undefined) {
      tool.arguments = appendArguments(tool.arguments, patch.arguments);
    }
  }

  private ingestMessageToolCalls(message: JsonObject): void {
    for (const [index, item] of collectRawToolCalls(message).entries()) {
      this.ingestToolDelta(index, { call_id: item.id, name: item.name, arguments: item.arguments });
    }
  }

  private finishReasoning(): string[] {
    if (this.reasoningIndex === null) return [];
    return [
      this.event("response.reasoning_text.done", {
        item_id: this.reasoningId,
        output_index: this.reasoningIndex,
        text: this.reasoning,
      }),
      this.event("response.output_item.done", {
        output_index: this.reasoningIndex,
        item: reasoningItem(this.responseId, this.reasoning),
      }),
    ];
  }

  /** Strip JSON/XML tool dumps from the text; they become real calls only if none streamed. */
  private adoptToolCallsFromText(): void {
    const extracted = extractToolCallsFromText(this.text);
    if (extracted.calls.length === 0) return;
    this.text = extracted.text;
    if (this.tools.size > 0) return;
    for (const [index, call] of extracted.calls.entries()) {
      this.ingestToolDelta(index, {
        call_id: `call_text_${index}`,
        name: call.name,
        arguments: call.arguments,
      });
    }
  }

  private sanitizedTools(): ToolAccum[] {
    return [...this.tools.entries()]
      .sort((a, b) => a[0] - b[0])
      .flatMap(([, tool]) => {
        const sanitized = sanitizeToolCall(tool.name, tool.arguments);
        if (!sanitized) return [];
        tool.name = sanitized.name;
        tool.arguments = sanitized.arguments;
        return [tool];
      });
  }

  // OpenAI Responses spec: add the item with empty arguments, then delta the JSON
  // once. Putting arguments on both added and delta concatenates them and
  // OpenCode aborts the unparseable call.
  private toolEvents(tool: ToolAccum): string[] {
    const out = [
      this.event("response.output_item.added", {
        output_index: tool.outputIndex,
        item: functionCallItem(tool, "in_progress"),
      }),
    ];
    if (tool.arguments) {
      out.push(
        this.event("response.function_call_arguments.delta", {
          item_id: tool.id,
          output_index: tool.outputIndex,
          delta: tool.arguments,
        })
      );
    }
    out.push(
      this.event("response.function_call_arguments.done", {
        item_id: tool.id,
        output_index: tool.outputIndex,
        arguments: tool.arguments,
      }),
      this.event("response.output_item.done", {
        output_index: tool.outputIndex,
        item: functionCallItem(tool, "completed"),
      })
    );
    return out;
  }

  private finishMessage(): string[] {
    if (this.messageIndex === null) return [];
    const out: string[] = [];
    const text = this.text;
    if (this.textPartAdded) {
      out.push(
        this.event("response.output_text.done", {
          item_id: this.messageId,
          output_index: this.messageIndex,
          content_index: 0,
          text,
        }),
        this.event("response.content_part.done", {
          item_id: this.messageId,
          output_index: this.messageIndex,
          content_index: 0,
          part: { type: "output_text", text },
        })
      );
    }
    out.push(
      this.event("response.output_item.done", {
        output_index: this.messageIndex,
        item: messageItem(this.responseId, text),
      })
    );
    return out;
  }

  private completedResponse(tools: ToolAccum[]): JsonObject {
    const message = {
      content: this.text,
      reasoning_content: this.reasoning || undefined,
      tool_calls: tools.map((tool) => ({
        id: tool.call_id,
        type: "function",
        function: { name: tool.name, arguments: tool.arguments },
      })),
    };
    return chatJsonToResponses({ id: this.responseId, choices: [{ message }] }, this.publicModel);
  }
}

export async function* chatStreamToResponses(
  stream: ReadableStream<Uint8Array>,
  publicModel: string,
  responseId: string
): AsyncGenerator<string> {
  const translator = new ResponsesStreamTranslator(responseId, publicModel);
  yield* translator.start();

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const chunk = parseChatSseLine(line);
        if (chunk) yield* translator.ingestChunk(chunk);
      }
    }
  } finally {
    reader.releaseLock();
  }

  translator.ingestTrailingJson(buffer);
  yield* translator.finish();
}
