import { isProviderReady, type Settings } from "../config/settings.js";
import { providerById } from "../providers/catalog.js";
import {
  isCatalogAlias,
  parseModelRef,
  providerApiKey,
  providerBaseUrl,
  type ModelRef,
} from "./models.js";
import { normalizeChatTools } from "./responses.js";

export type ChatRequest = {
  model: string;
  stream?: boolean;
  [key: string]: unknown;
};

export type RouteAttempt = {
  ref: ModelRef;
  baseUrl: string;
  apiKey: string;
};

export class RouteError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status = 502, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body ?? { error: { message, type: "proxy_error" } };
  }
}

export function routeTargets(settings: Settings, requestedModel: string): ModelRef[] {
  const seen = new Set<string>();
  const targets: ModelRef[] = [];
  const push = (raw: string | null | undefined): void => {
    if (!raw || isCatalogAlias(raw)) return;
    try {
      const ref = parseModelRef(raw);
      if (seen.has(ref.slug)) return;
      seen.add(ref.slug);
      targets.push(ref);
    } catch {
      // skip malformed ids
    }
  };
  if (!isCatalogAlias(requestedModel)) push(requestedModel);
  push(settings.model);
  for (const extra of settings.fallbacks) push(extra);
  return targets.filter((ref) => isProviderReady(settings, ref.providerId));
}

export function resolveAttempt(settings: Settings, ref: ModelRef): RouteAttempt {
  const provider = providerById(ref.providerId);
  if (!provider) throw new RouteError(`Unknown provider '${ref.providerId}'`, 400);
  return {
    ref,
    baseUrl: providerBaseUrl(settings, provider),
    apiKey: providerApiKey(settings, provider),
  };
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export type UpstreamTransport = (
  attempt: RouteAttempt,
  body: ChatRequest,
  signal?: AbortSignal
) => Promise<Response>;

const CHAT_FIELDS = [
  "messages",
  "stream",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "tools",
  "tool_choice",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "user",
  "n",
  "seed",
  "response_format",
  "stream_options",
  "parallel_tool_calls",
  "reasoning_effort",
] as const;

export function sanitizeChatPayload(
  body: ChatRequest,
  upstreamModel: string,
  providerId?: string
): ChatRequest {
  const payload: ChatRequest = { model: upstreamModel };
  const copy = payload as Record<string, unknown>;
  for (const field of CHAT_FIELDS) {
    if (body[field] !== undefined) copy[field] = body[field];
  }
  if (payload.max_tokens === undefined && typeof body.max_output_tokens === "number") {
    payload.max_tokens = body.max_output_tokens;
  }
  if (payload.tools !== undefined) {
    const tools = normalizeChatTools(payload.tools);
    if (tools) payload.tools = tools;
  }
  if (
    providerId === "nvidia_nim" &&
    body.chat_template_kwargs === undefined &&
    !wantsReasoning(body)
  ) {
    payload.chat_template_kwargs = { enable_thinking: false };
  }
  return payload;
}

function wantsReasoning(body: ChatRequest): boolean {
  const effortFromField =
    typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined;
  const reasoning = body.reasoning;
  const effortFromObj =
    reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)
      ? (reasoning as { effort?: unknown }).effort
      : undefined;
  const effort = effortFromField ?? (typeof effortFromObj === "string" ? effortFromObj : undefined);
  return Boolean(effort && effort !== "none" && effort !== "off" && effort !== "minimal");
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError")
  );
}

export async function defaultTransport(
  attempt: RouteAttempt,
  body: ChatRequest,
  signal?: AbortSignal
): Promise<Response> {
  if (signal?.aborted) {
    throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  }
  const payload = sanitizeChatPayload(body, attempt.ref.model, attempt.ref.providerId);
  return fetch(`${attempt.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${attempt.apiKey}`,
      "Content-Type": "application/json",
      Accept: payload.stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });
}

export type RoutedResult = {
  response: Response;
  used: ModelRef;
  tried: string[];
};

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      return parsed.error?.message || text.slice(0, 400);
    } catch {
      return text.slice(0, 400);
    }
  } catch {
    return `HTTP ${response.status}`;
  }
}

export async function routeChat(
  settings: Settings,
  body: ChatRequest,
  transport: UpstreamTransport = defaultTransport,
  signal?: AbortSignal
): Promise<RoutedResult> {
  const targets = routeTargets(settings, body.model);
  if (targets.length === 0) {
    throw new RouteError(
      isCatalogAlias(body.model)
        ? "No default model. Set one in Admin or `free-opencode set-model`, and Connect a provider."
        : "No ready provider for this model. Add an API key in the Admin UI or `free-opencode connect`.",
      400
    );
  }

  const tried: string[] = [];
  let lastError: RouteError | null = null;

  for (const ref of targets) {
    tried.push(ref.slug);
    let attempt: RouteAttempt;
    try {
      attempt = resolveAttempt(settings, ref);
    } catch (error) {
      lastError = error instanceof RouteError ? error : new RouteError(String(error), 400);
      continue;
    }

    let response: Response;
    try {
      response = await transport(attempt, body, signal);
    } catch (error) {
      lastError = new RouteError(
        `${ref.slug} network error: ${error instanceof Error ? error.message : String(error)}`,
        502
      );
      if (isAbortError(error) || signal?.aborted) {
        throw lastError;
      }
      continue;
    }

    if (response.ok) {
      return { response, used: ref, tried };
    }

    const retryable = isRetryableStatus(response.status);
    const message = await readErrorMessage(response);
    lastError = new RouteError(`${ref.slug}: ${message}`, response.status);
    if (!retryable) {
      throw lastError;
    }
  }

  throw lastError ?? new RouteError("All configured models failed", 502, { tried });
}
