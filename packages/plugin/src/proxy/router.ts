import { isProviderReady, type Settings } from "../config/settings.js";
import { allProviders, providerById, type ProviderDescriptor } from "../providers/catalog.js";
import { isCooldowned, clearCooldown, parseRetryAfterHeader, recordCooldown } from "./cooldown.js";
import {
  isCatalogAlias,
  isFreeModelId,
  listedModelsForProvider,
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

/**
 * True when the provider id points at a self-hosted box (Ollama / SGLang / LM
 * Studio / llama.cpp, or a Tailscale / inventory / autofind host). These are
 * last-resort buckets in routeTargets.
 */
export function isSelfHostedProvider(providerId: string): boolean {
  return Boolean(providerById(providerId)?.local);
}

/** A model slug is a "free" candidate when its model id looks free (:free / -free / /free / leaves). */
export function isFreeModelSlug(ref: ModelRef): boolean {
  return isFreeModelId(ref.model);
}

function parseOrNull(raw: string): ModelRef | null {
  try {
    return parseModelRef(raw);
  } catch {
    return null;
  }
}

/**
 * Build the ordered attempt list for a request.
 *
 * Policy (free-first, self-hosted-last):
 *   1. An explicit concrete slug always goes first (never rewritten).
 *   2. Free cloud — Admin free default/fallbacks first. On catalog-alias
 *      traffic, other free listings may fill in (see below), so a paid Admin
 *      default never outranks free when no fallback list is set.
 *   3. Paid cloud — Admin paid default/fallbacks only. Alias traffic never
 *      auto-enumerates other paid catalog defaults (no surprise gpt-5.5 hops).
 *   4. Self-hosted last — local boxes only after free and paid cloud cannot
 *      serve right now (not ready, in cooldown, or failed retryable).
 *
 * Alias free fill-in:
 *   - Empty Admin fallbacks → every ready cloud provider's free models.
 *   - Non-empty fallbacks → free models only from providers already named in
 *     Admin default/fallbacks (so OpenRouter `:free` siblings can help, but
 *     Zen `big-pickle` does not appear unless Zen is configured).
 *
 * Bare provider ids in Admin (e.g. `groq`) expand to that provider's listed
 * models. Explicit concrete requests still use Admin default/fallbacks only
 * for the tail (no free fill-in). Cooldowned slugs are skipped; the first
 * request after expiry is the recheck.
 */
export function routeTargets(settings: Settings, requestedModel: string): ModelRef[] {
  const aliasRequest = isCatalogAlias(requestedModel);
  const seen = new Set<string>();
  const targets: ModelRef[] = [];
  const push = (raw: string | null | undefined): void => {
    if (!raw || isCatalogAlias(raw)) return;
    const ref = parseOrNull(raw);
    if (!ref) return;
    if (seen.has(ref.slug) || isCooldowned(ref.slug)) return;
    seen.add(ref.slug);
    targets.push(ref);
  };

  if (!aliasRequest) push(requestedModel);

  // Partition Admin default + fallbacks into free cloud / paid cloud / local.
  // A bare provider id expands to that provider's listed models.
  const adminCloudFree: string[] = [];
  const adminCloudPaid: string[] = [];
  const adminLocal: string[] = [];
  const adminProviderIds = new Set<string>();
  const configuredFallbacks = (settings.fallbacks ?? []).filter(
    (raw) => Boolean(raw?.trim()) && !isCatalogAlias(raw)
  );

  const partitionSlug = (slug: string): void => {
    const ref = parseOrNull(slug);
    if (!ref) return;
    adminProviderIds.add(ref.baseProviderId);
    if (isSelfHostedProvider(ref.providerId)) adminLocal.push(slug);
    else if (isFreeModelSlug(ref)) adminCloudFree.push(slug);
    else adminCloudPaid.push(slug);
  };

  for (const raw of [settings.model, ...configuredFallbacks]) {
    if (!raw || isCatalogAlias(raw)) continue;
    const trimmed = raw.trim();
    const bare = providerById(trimmed);
    if (bare) {
      adminProviderIds.add(bare.id);
      for (const model of listedModelsForProvider(settings, bare)) {
        partitionSlug(`${bare.id}/${model}`);
      }
      continue;
    }
    partitionSlug(trimmed);
  }

  // Free cloud always leads: Admin free default/fallbacks first.
  for (const raw of adminCloudFree) push(raw);

  if (aliasRequest) {
    const readyCloud = allProviders().filter((p) => !p.local && isProviderReady(settings, p.id));
    // Empty fallbacks → any connected free. Otherwise only providers the
    // operator already named in default/fallbacks.
    const freeFillProviders =
      configuredFallbacks.length === 0
        ? readyCloud
        : readyCloud.filter((p) => adminProviderIds.has(p.id));
    for (const provider of freeFillProviders) {
      for (const model of listedModelsForProvider(settings, provider)) {
        const ref = parseOrNull(`${provider.id}/${model}`);
        if (!ref || seen.has(ref.slug) || isCooldowned(ref.slug)) continue;
        if (isFreeModelSlug(ref)) push(ref.slug);
      }
    }
    // Paid cloud: Admin list only — never every ready provider's paid catalog.
    for (const raw of adminCloudPaid) push(raw);
  } else {
    for (const raw of adminCloudPaid) push(raw);
  }

  // Self-hosted last: Admin-local default first, then every ready local box.
  for (const raw of adminLocal) push(raw);
  for (const provider of allProviders()) {
    if (!provider.local || !isProviderReady(settings, provider.id)) continue;
    for (const model of listedModelsForProvider(settings, provider)) {
      push(`${provider.id}/${model}`);
    }
  }

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
  // 402 Payment Required: this model/account cannot pay (OpenRouter
  // "never purchased credits"). Skip the slug and keep walking — do not
  // abort the session. 401 stays fatal (wrong key).
  return status === 402 || status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Context/payload too big for this model — try the next one, do not kill the session. */
export function isContextOverflow(status: number, message: string): boolean {
  if (status === 413) return true;
  const text = message.toLowerCase();
  if (!/context|token|compact|too large|too long|payload|max_tokens|stripping media/.test(text)) {
    return status === 413;
  }
  return (
    status === 400 ||
    status === 413 ||
    /context[_\s-]?length|context (window|limit)|too large to compact|stripping media|maximum context|too many tokens|prompt is too long|request too large|payload too large/.test(
      text
    )
  );
}

export function shouldSkipToNextModel(status: number, message: string): boolean {
  return isRetryableStatus(status) || isContextOverflow(status, message);
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
  const baseProvider = providerId?.split("@")[0] ?? providerId;
  if (
    baseProvider === "nvidia_nim" &&
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
  latencyMs: number;
  fallback: number | boolean;
};

/** One upstream hop a routeChat made (success or failure), for logging/observability. */
export type RouteHopInfo = {
  requestId?: string;
  slug: string;
  providerId: string;
  /** HTTP status of the upstream call; null when the transport threw pre-response. */
  status: number | null;
  latencyMs: number;
  ok: boolean;
  /** false = primary attempt, number = failed fallbacks already tried (slots 1..). */
  fallback: boolean | number;
  tried: string[];
  message?: string;
};

export type RouteHopObserver = (hop: RouteHopInfo) => void;

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
  signal?: AbortSignal,
  onHop?: RouteHopObserver,
  home?: string
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
  let lastLatencyMs = 0;
  let lastFallback: number | boolean = 0;
  /** After a 402, remaining paid slugs on that provider will also fail. */
  const skipPaidFrom = new Set<string>();

  for (const ref of targets) {
    if (skipPaidFrom.has(ref.providerId) && !isFreeModelSlug(ref)) {
      continue;
    }
    tried.push(ref.slug);
    const fallback = tried.length - 1;
    let attempt: RouteAttempt;
    try {
      attempt = resolveAttempt(settings, ref);
    } catch (error) {
      lastError = error instanceof RouteError ? error : new RouteError(String(error), 400);
      continue;
    }

    const started = Date.now();
    let response: Response;
    try {
      response = await transport(attempt, body, signal);
    } catch (error) {
      const latencyMs = Date.now() - started;
      lastError = new RouteError(
        `${ref.slug} network error: ${error instanceof Error ? error.message : String(error)}`,
        502
      );
      emitHop(onHop, ref, fallback, tried, null, latencyMs, false, lastError.message);
      if (isAbortError(error) || signal?.aborted) {
        throw lastError;
      }
      continue;
    }

    const latencyMs = Date.now() - started;
    if (response.ok) {
      clearCooldown(ref.slug);
      emitHop(onHop, ref, fallback, tried, response.status, latencyMs, true);
      lastLatencyMs = latencyMs;
      lastFallback = fallback > 0 ? fallback : 0;
      return { response, used: ref, tried, latencyMs: lastLatencyMs, fallback: lastFallback };
    }

    const message = await readErrorMessage(response);
    const overflow = isContextOverflow(response.status, message);
    const retryable = shouldSkipToNextModel(response.status, message);
    if (retryable && !overflow) {
      const retryAfterValue = response.headers.get("retry-after");
      recordCooldown(ref.slug, ref.providerId, {
        status: response.status,
        retryAfter: parseRetryAfterHeader(retryAfterValue),
        reason: message,
        home,
      });
    }
    lastError = new RouteError(`${ref.slug}: ${message}`, response.status);
    emitHop(onHop, ref, fallback, tried, response.status, latencyMs, false, lastError.message);
    if (!retryable) {
      throw lastError;
    }
    if (response.status === 402) {
      skipPaidFrom.add(ref.providerId);
    }
  }

  throw lastError ?? new RouteError("All configured models failed", 502, { tried });
}

function emitHop(
  onHop: RouteHopObserver | undefined,
  ref: ModelRef,
  fallback: number,
  tried: string[],
  status: number | null,
  latencyMs: number,
  ok: boolean,
  message?: string
): void {
  onHop?.({
    slug: ref.slug,
    providerId: ref.providerId,
    status,
    latencyMs,
    ok,
    fallback: fallback > 0 ? fallback : false,
    tried,
    ...(message ? { message } : {}),
  });
}
