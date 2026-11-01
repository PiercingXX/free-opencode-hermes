import { isProviderReady, type Settings } from "../config/settings.js";
import { allProviders, providerById, type ProviderDescriptor } from "../providers/catalog.js";
import {
  breakerAllows,
  isProviderLevelFailure,
  openBreakers,
  recordProviderFailure,
  recordProviderSuccess,
} from "./breaker.js";
import {
  compactMessages,
  DEFAULT_COMPACTION,
  type CompactionMode,
  type CompactionReport,
} from "./compact.js";
import {
  activeCooldowns,
  clearCooldown,
  isCooldowned,
  parseRetryAfterHeader,
  recordCooldown,
} from "./cooldown.js";
import {
  fitsContext,
  lastKnownGood,
  latencyOf,
  recordContextOverflow,
  recordLatency,
  recordSuccess,
  requestSize,
} from "./route-stats.js";
import {
  catalogAliasPreset,
  isCatalogAlias,
  isFreeModelId,
  isBaiAutoRoutedModel,
  isFreeOrLearnedOpen,
  listedModelsForProvider,
  parseModelRef,
  providerApiKey,
  providerBaseUrl,
  type ModelRef,
} from "./models.js";
import {
  ACCESS_PROBE_TIMEOUT_MS,
  classifyAccessStatus,
  isPaywallMessage,
  type ModelAccessStatus,
  probeProviderAccess,
  providerNeedsAccessProbe,
  readErrorMessage,
  rememberAccess,
  rememberedAccess,
  sendAccessProbe,
} from "./model-access.js";
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

/** A model slug is free when the leaf says so, or we learned it is open (not paywalled). */
export function isFreeModelSlug(ref: ModelRef, settings?: Settings): boolean {
  if (settings) return isFreeOrLearnedOpen(settings, ref.baseProviderId, ref.model);
  return isFreeModelId(ref.model, ref.baseProviderId);
}

/** Rank sibling-fill candidates: free/open → defaults → flash/lite → other → premium → paywall. */
export function siblingRank(
  providerId: string,
  model: string,
  defaults: Set<string>,
  settings?: Settings
): number {
  const slug = `${providerId}/${model}`;
  if (settings && rememberedAccess(settings, slug) === "paywall") return 5;
  if (isFreeOrLearnedOpen(settings ?? { modelAccess: {} }, providerId, model)) return 0;
  if (defaults.has(model)) return 1;
  const n = model.toLowerCase();
  // B.ai "nano" is premium despite the name; treat with other high-cost leaves.
  if (/(^|[-_.])(nano|pro|opus|sonnet|fable|max)($|[-_.])/.test(n)) return 4;
  if (/(flash|lite|small|mini|coder|hy3|mimo-v2\.5)/.test(n)) return 2;
  return 3;
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
 *      auto-enumerates every ready provider's paid catalog.
 *   4. Sibling fill (alias + empty fallbacks only) — other listed models from
 *      providers already named in Admin default, so a TPM 429 on the promo
 *      free model can hop within that provider instead of dying with an empty
 *      chain. Explicit fallback lists stay exclusive.
 *   5. Self-hosted last — local boxes only after free and paid cloud cannot
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
 * for the tail (no free/sibling fill-in). Cooldowned slugs are skipped; the
 * first request after expiry is the recheck.
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
    // Known deposit walls stay out of the hop chain until Connect forgets them.
    if (rememberedAccess(settings, ref.slug) === "paywall") return;
    // A provider whose breaker is open is down as a whole; skip all its models.
    if (!breakerAllows(ref.providerId)) return;
    seen.add(ref.slug);
    targets.push(ref);
    // Key rotation: the same model on the provider's other accounts follows
    // directly, so a 429 on one key hops to the next key before another model.
    for (const sibling of accountSiblings(settings, ref)) push(`${sibling}/${ref.model}`);
  };

  if (!aliasRequest) push(requestedModel);

  const admin = partitionAdminSlugs(settings);
  // Free cloud always leads: Admin free default/fallbacks first.
  admin.cloudFree.forEach(push);

  if (aliasRequest) {
    aliasFreeFill(settings, admin).forEach(push);
    // Paid cloud: Admin list only — never every ready provider's paid catalog.
    admin.cloudPaid.forEach(push);
    aliasSiblingFill(settings, admin).forEach(push);
  } else {
    admin.cloudPaid.forEach(push);
  }

  // Self-hosted last: Admin-local default first, then every ready local box.
  admin.local.forEach(push);
  for (const provider of allProviders()) {
    if (!provider.local || !isProviderReady(settings, provider.id)) continue;
    for (const model of listedModelsForProvider(settings, provider)) {
      push(`${provider.id}/${model}`);
    }
  }

  const ready = targets.filter((ref) => isProviderReady(settings, ref.providerId));
  return applyPreset(settings, ready, catalogAliasPreset(requestedModel));
}

type AdminSlugs = {
  cloudFree: string[];
  cloudPaid: string[];
  local: string[];
  /** Base providers named anywhere in Admin default/fallbacks. */
  providerIds: Set<string>;
  hasFallbacks: boolean;
};

/**
 * Partition Admin default + fallbacks into free cloud / paid cloud / local.
 * A bare provider id expands to that provider's listed models.
 */
function partitionAdminSlugs(settings: Settings): AdminSlugs {
  const fallbacks = (settings.fallbacks ?? []).filter(
    (raw) => Boolean(raw?.trim()) && !isCatalogAlias(raw)
  );
  const admin: AdminSlugs = {
    cloudFree: [],
    cloudPaid: [],
    local: [],
    providerIds: new Set(),
    hasFallbacks: fallbacks.length > 0,
  };
  const partition = (slug: string): void => {
    const ref = parseOrNull(slug);
    if (!ref) return;
    admin.providerIds.add(ref.baseProviderId);
    if (isSelfHostedProvider(ref.providerId)) admin.local.push(slug);
    else if (isFreeModelSlug(ref, settings)) admin.cloudFree.push(slug);
    else admin.cloudPaid.push(slug);
  };

  for (const raw of [settings.model, ...fallbacks]) {
    if (!raw || isCatalogAlias(raw)) continue;
    const trimmed = raw.trim();
    const bare = providerById(trimmed);
    if (!bare) {
      partition(trimmed);
      continue;
    }
    admin.providerIds.add(bare.id);
    for (const model of autoRoutableModels(settings, bare)) partition(`${bare.id}/${model}`);
  }
  return admin;
}

/** Listed models auto-routing may use; B.ai only offers models that passed the access probe. */
function autoRoutableModels(settings: Settings, provider: ProviderDescriptor): string[] {
  const models = listedModelsForProvider(settings, provider);
  if (provider.id !== "bai" && provider.baseProviderId !== "bai") return models;
  return models.filter((model) => isBaiAutoRoutedModel(model, settings, provider.id));
}

function readyCloudProviders(settings: Settings): ProviderDescriptor[] {
  return allProviders().filter((p) => !p.local && isProviderReady(settings, p.id));
}

/**
 * Alias free fill-in. Empty fallbacks → any connected free, Admin-named
 * providers first so probed B.ai opens hop before unrelated OpenRouter
 * freeloaders. Explicit fallback lists remain an allowlist of providers only.
 */
function aliasFreeFill(settings: Settings, admin: AdminSlugs): string[] {
  const ready = readyCloudProviders(settings);
  const named = ready.filter((p) => admin.providerIds.has(p.id));
  const providers = admin.hasFallbacks
    ? named
    : [...named, ...ready.filter((p) => !admin.providerIds.has(p.id))];
  const slugs: string[] = [];
  for (const provider of providers) {
    for (const model of listedModelsForProvider(settings, provider)) {
      const ref = parseOrNull(`${provider.id}/${model}`);
      if (ref && isFreeModelSlug(ref, settings)) slugs.push(ref.slug);
    }
  }
  return slugs;
}

/**
 * Sibling fill: with empty fallbacks, other listed models of Admin-named
 * providers (ranked by siblingRank) so a cooled free default can hop.
 * Explicit fallback lists remain an allowlist.
 */
function aliasSiblingFill(settings: Settings, admin: AdminSlugs): string[] {
  if (admin.hasFallbacks || admin.providerIds.size === 0) return [];
  const slugs: string[] = [];
  for (const provider of readyCloudProviders(settings)) {
    if (!admin.providerIds.has(provider.id)) continue;
    const defaults = new Set(provider.defaultModels);
    const rank = (model: string): number => siblingRank(provider.id, model, defaults, settings);
    const ranked = [...autoRoutableModels(settings, provider)].sort(
      (a, b) => rank(a) - rank(b) || a.localeCompare(b)
    );
    for (const model of ranked) slugs.push(`${provider.id}/${model}`);
  }
  return slugs;
}

/**
 * Other ready accounts of the same base provider, from the *live* settings
 * (the provider catalog's account view is read from disk and can lag).
 */
function accountSiblings(settings: Settings, ref: ModelRef): string[] {
  const base = ref.baseProviderId;
  const ids = [
    base,
    ...(settings.accounts ?? []).filter((a) => a.providerId === base).map((a) => `${base}@${a.id}`),
  ];
  return ids.filter((id) => id !== ref.providerId && isProviderReady(settings, id));
}

/** Free cloud → paid cloud → self-hosted; presets reorder within a tier only. */
function tierOf(settings: Settings, ref: ModelRef): number {
  if (isSelfHostedProvider(ref.providerId)) return 2;
  return isFreeModelSlug(ref, settings) ? 0 : 1;
}

/**
 * `auto/fast` orders each tier by measured latency; `auto/sticky` moves the
 * last model that answered to the front. Neither ever promotes a paid or
 * self-hosted model above free cloud — free-first stays the policy.
 */
function applyPreset(
  settings: Settings,
  targets: ModelRef[],
  preset: "fast" | "sticky" | null
): ModelRef[] {
  if (preset === "fast") {
    return targets
      .map((ref, index) => ({ ref, index, tier: tierOf(settings, ref), ms: latencyOf(ref.slug) }))
      .sort((a, b) => a.tier - b.tier || a.ms - b.ms || a.index - b.index)
      .map((row) => row.ref);
  }
  if (preset === "sticky") {
    const good = lastKnownGood();
    const at = targets.findIndex((ref) => ref.slug === good);
    if (at <= 0) return targets;
    const pinned = targets[at];
    const rest = targets.filter((_, index) => index !== at);
    // Only jump ahead of models in the same or a worse tier.
    const tier = tierOf(settings, pinned);
    const insertAt = rest.findIndex((ref) => tierOf(settings, ref) >= tier);
    rest.splice(insertAt < 0 ? rest.length : insertAt, 0, pinned);
    return rest;
  }
  return targets;
}

export function resolveAttempt(settings: Settings, ref: ModelRef): RouteAttempt {
  const found = providerById(ref.providerId);
  if (!found) throw new RouteError(`Unknown provider '${ref.providerId}'`, 400);
  // An account not yet in the on-disk catalog resolves to its base
  // descriptor; keys and extras must still come from `provider@account`.
  const provider =
    found.id === ref.providerId
      ? found
      : { ...found, id: ref.providerId, baseProviderId: found.baseProviderId ?? found.id };
  return {
    ref,
    baseUrl: providerBaseUrl(settings, provider),
    apiKey: providerApiKey(settings, provider),
  };
}

export function isRetryableStatus(status: number): boolean {
  // 402 Payment Required / 403 Access Restricted (B.ai deposit, etc.): this
  // model cannot serve the key. Skip the slug and keep walking — do not abort
  // the session. 401 stays fatal (wrong key). 404 is a vanished SKU (OpenRouter
  // stealth previews drop off the catalog after reveal).
  return (
    status === 402 ||
    status === 403 ||
    status === 404 ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500
  );
}

/** Upstream says this model id is gone / unknown — hop, do not kill the turn. */
export function isUnavailableModel(status: number, message = ""): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  return /not found|no endpoints|is not a valid model|unknown model|model .* does not exist|invalid model/i.test(
    message
  );
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
  return (
    isRetryableStatus(status) ||
    isUnavailableModel(status, message) ||
    isContextOverflow(status, message) ||
    isPaywallMessage(status, message)
  );
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
    headers: upstreamHeaders(attempt, Boolean(payload.stream)),
    body: JSON.stringify(payload),
    signal,
  });
}

/** OpenRouter free/stealth SKUs expect an identifying Referer; other providers ignore extras. */
export function upstreamHeaders(attempt: RouteAttempt, stream: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${attempt.apiKey}`,
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
  };
  if (attempt.ref.baseProviderId === "open_router") {
    headers["HTTP-Referer"] = "https://github.com/PiercingXX/free-opencode-hermes";
    headers["X-Title"] = "Free OpenCode";
  }
  return headers;
}

export type RoutedResult = {
  response: Response;
  used: ModelRef;
  tried: string[];
  latencyMs: number;
  fallback: number | boolean;
  /** Settings after access probes / learning. Only `modelAccess` ever changes. */
  settings: Settings;
  compaction: CompactionReport;
};

export type RouteOptions = {
  signal?: AbortSignal;
  onHop?: RouteHopObserver;
  /** Home dir for the persisted cooldown store. Tests omit it. */
  home?: string;
  /**
   * Called whenever routing learns model access (open / paywall). The router
   * never writes settings itself: it works on a request-local snapshot, and
   * saving that snapshot would revert concurrent Admin edits.
   */
  onLearned?: (modelAccess: Settings["modelAccess"]) => void;
  compaction?: CompactionMode;
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

function noTargetsError(settings: Settings, requestedModel: string): RouteError {
  const cooled = activeCooldowns();
  const broken = openBreakers();
  const cooledHint =
    cooled.length > 0
      ? ` Active cooldowns: ${cooled.map((c) => c.slug).join(", ")}. Wait or set fallbacks.`
      : "";
  const brokenHint =
    broken.length > 0
      ? ` Providers failing (circuit open): ${broken.map((b) => b.providerId).join(", ")}.`
      : "";
  const probeHint =
    isProviderReady(settings, "bai") &&
    !Object.values(settings.modelAccess ?? {}).some((e) => e.status === "open")
      ? " No B.ai models passed the access probe (deposit/balance). Re-Connect B.ai or set an explicit fallback."
      : "";
  const message = isCatalogAlias(requestedModel)
    ? settings.model
      ? `No live models to try (default ${settings.model} may be in cooldown).${cooledHint}${brokenHint}${probeHint} Set fallbacks in Admin or \`free-opencode set-fallback\`.`
      : "No default model. Set one in Admin or `free-opencode set-model`, and Connect a provider."
    : "No ready provider for this model. Add an API key in the Admin UI or `free-opencode connect`.";
  return new RouteError(message, cooled.length > 0 || broken.length > 0 ? 503 : 400);
}

/** Entries that differ between two access maps (only what this request learned). */
function changedAccess(
  before: Settings["modelAccess"],
  after: Settings["modelAccess"]
): Settings["modelAccess"] {
  const delta: Settings["modelAccess"] = {};
  for (const [slug, entry] of Object.entries(after ?? {})) {
    if (JSON.stringify(before?.[slug]) !== JSON.stringify(entry)) delta[slug] = entry;
  }
  return delta;
}

export async function routeChat(
  settings: Settings,
  requestBody: ChatRequest,
  transport: UpstreamTransport = defaultTransport,
  options: RouteOptions = {}
): Promise<RoutedResult> {
  const { signal, onHop, home } = options;
  let liveSettings = settings;
  const learn = (next: Settings): void => {
    const delta = changedAccess(liveSettings.modelAccess, next.modelAccess);
    liveSettings = next;
    if (Object.keys(delta).length > 0) options.onLearned?.(delta);
  };

  // B.ai (and similar) must be live-probed before free-first auto-routing.
  // Probe uses its own timeout — do not bind the chat AbortSignal or a client
  // disconnect mid-probe leaves modelAccess empty and skips free B.ai hops.
  if (isProviderReady(liveSettings, "bai") && providerNeedsAccessProbe(liveSettings, "bai")) {
    learn((await probeProviderAccess(liveSettings, "bai")).settings);
  }

  const compacted = compactMessages(requestBody.messages, {
    ...DEFAULT_COMPACTION,
    mode: options.compaction ?? DEFAULT_COMPACTION.mode,
  });
  const body: ChatRequest =
    compacted.report.savedChars > 0
      ? { ...requestBody, messages: compacted.messages }
      : requestBody;
  const size = requestSize(body);

  const targets = routeTargets(liveSettings, body.model);
  if (targets.length === 0) throw noTargetsError(liveSettings, body.model);
  // Skip models that already overflowed on a request this large — unless that
  // would leave nothing, in which case try anyway (limits are learned, not known).
  const fitting = targets.filter((ref) => fitsContext(ref.slug, size));
  if (fitting.length > 0 && fitting.length < targets.length) {
    targets.splice(0, targets.length, ...fitting);
  }

  const tried: string[] = [];
  let lastError: RouteError | null = null;
  /** After a 402, remaining paid slugs on that provider will also fail. */
  const skipPaidFrom = new Set<string>();
  /** Providers we already scanned for open siblings after a paywall this request. */
  const probedPaywallProviders = new Set<string>();

  // `targets` may grow while we walk it (B.ai re-probe after a paywall).
  for (const ref of targets) {
    if (rememberedAccess(liveSettings, ref.slug) === "paywall") continue;
    if (skipPaidFrom.has(ref.providerId) && !isFreeModelSlug(ref, liveSettings)) continue;
    // The breaker may have opened earlier in this same request.
    if (!breakerAllows(ref.providerId)) continue;
    tried.push(ref.slug);
    const fallback = tried.length - 1;
    let attempt: RouteAttempt;
    try {
      attempt = resolveAttempt(liveSettings, ref);
    } catch (error) {
      lastError = error instanceof RouteError ? error : new RouteError(String(error), 400);
      continue;
    }

    const local = isSelfHostedProvider(ref.providerId);
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
      if (isAbortError(error) || signal?.aborted) throw lastError;
      recordProviderFailure(ref.providerId, local);
      continue;
    }

    const latencyMs = Date.now() - started;
    if (response.ok) {
      recordSuccessfulResponse(ref, latencyMs, size);
      if (rememberedAccess(liveSettings, ref.slug) !== "open") {
        learn(rememberAccess(liveSettings, ref.slug, "open"));
      }
      emitHop(onHop, ref, fallback, tried, response.status, latencyMs, true);
      return {
        response,
        used: ref,
        tried,
        latencyMs,
        fallback: fallback > 0 ? fallback : 0,
        settings: liveSettings,
        compaction: compacted.report,
      };
    }

    const message = await readErrorMessage(response);
    const { access, retryable } = recordFailedResponse(ref, response, message, size, home);
    if (access) learn(rememberAccess(liveSettings, ref.slug, access, message));
    lastError = new RouteError(`${ref.slug}: ${message}`, response.status);
    emitHop(onHop, ref, fallback, tried, response.status, latencyMs, false, lastError.message);
    if (!retryable) throw lastError;

    // 402 is usually account-wide (no credits). Per-model deposit (403) must not
    // skip the rest — probe remaining free-looking siblings so a lumped free
    // model can still answer.
    if (response.status === 402) {
      skipPaidFrom.add(ref.providerId);
      continue;
    }
    if (access !== "paywall" || probedPaywallProviders.has(ref.providerId) || signal?.aborted) {
      continue;
    }
    probedPaywallProviders.add(ref.providerId);
    if (ref.baseProviderId === "bai") {
      learn((await probeProviderAccess(liveSettings, ref.providerId, { force: true })).settings);
      appendNewTargets(targets, routeTargets(liveSettings, body.model), tried);
    } else {
      learn(await probeOpenSiblings(liveSettings, targets, tried, ref.providerId, home, signal));
    }
  }

  throw lastError ?? new RouteError("All configured models failed", 502, { tried });
}

/** Clear cooldown, close the breaker, and feed the latency/context stats. */
function recordSuccessfulResponse(ref: ModelRef, latencyMs: number, size: number): void {
  clearCooldown(ref.slug);
  recordProviderSuccess(ref.providerId);
  recordLatency(ref.slug, latencyMs);
  recordSuccess(ref.slug, size);
}

/**
 * Breaker / context-limit / cooldown bookkeeping for a non-OK upstream reply.
 * Overflow is not cooled: the model is fine, only this request is too big.
 */
function recordFailedResponse(
  ref: ModelRef,
  response: Response,
  message: string,
  size: number,
  home: string | undefined
): { access: ModelAccessStatus | null; retryable: boolean } {
  if (isProviderLevelFailure(response.status)) {
    recordProviderFailure(ref.providerId, isSelfHostedProvider(ref.providerId));
  }
  const access = classifyAccessStatus(response.status, message);
  const overflow = isContextOverflow(response.status, message);
  if (overflow) recordContextOverflow(ref.slug, size);
  const retryable = shouldSkipToNextModel(response.status, message);
  if (retryable && !overflow) {
    recordCooldown(ref.slug, ref.providerId, {
      status: response.status,
      retryAfter: parseRetryAfterHeader(response.headers.get("retry-after")),
      reason: message,
      home,
    });
  }
  return { access, retryable };
}

/** Append re-routed targets not already queued or tried. */
function appendNewTargets(targets: ModelRef[], next: ModelRef[], tried: string[]): void {
  const queued = new Set(targets.map((t) => t.slug));
  for (const ref of next) {
    if (queued.has(ref.slug) || tried.includes(ref.slug)) continue;
    queued.add(ref.slug);
    targets.push(ref);
  }
}

/**
 * After a deposit/paywall, lightly probe remaining free-looking siblings on the
 * same provider. Marks open vs paywall so the rest of this hop chain (and later
 * turns) prefer models that actually answer.
 */
export async function probeOpenSiblings(
  settings: Settings,
  targets: ModelRef[],
  alreadyTried: string[],
  providerId: string,
  home?: string,
  signal?: AbortSignal
): Promise<Settings> {
  const tried = new Set(alreadyTried);
  const candidates = targets
    .filter((ref) => {
      if (ref.providerId !== providerId || tried.has(ref.slug)) return false;
      if (rememberedAccess(settings, ref.slug) !== "unknown") return false;
      const base = ref.baseProviderId;
      if (base === "bai") return isBaiAutoRoutedModel(ref.model, settings, ref.providerId);
      return (
        isFreeModelId(ref.model, ref.baseProviderId) ||
        /(flash|hy3|mimo-v2\.5|lite|mini|coder)/i.test(ref.model)
      );
    })
    .slice(0, 6);

  let live = settings;
  await Promise.all(
    candidates.map(async (ref) => {
      if (signal?.aborted) return;
      try {
        const attempt = resolveAttempt(live, ref);
        const { httpStatus, message, access } = await sendAccessProbe(
          attempt.baseUrl,
          upstreamHeaders(attempt, false),
          ref.model,
          AbortSignal.timeout(ACCESS_PROBE_TIMEOUT_MS)
        );
        if (!access) return;
        live = rememberAccess(live, ref.slug, access, message);
        if (access === "paywall") {
          recordCooldown(ref.slug, ref.providerId, { status: httpStatus, reason: message, home });
        }
      } catch {
        // probe is best-effort
      }
    })
  );
  return live;
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
