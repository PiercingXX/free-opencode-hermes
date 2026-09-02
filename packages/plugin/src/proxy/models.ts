import { isProviderReady, type Settings } from "../config/settings.js";
import { CATALOG_MODEL_ID, PROVIDER_ID } from "../paths.js";
import {
  allProviders,
  isOllamaFamily,
  providerById,
  type ProviderDescriptor,
} from "../providers/catalog.js";

export type ModelRef = {
  providerId: string;
  model: string;
  slug: string;
};

export type CatalogView = "default" | "messages" | "responses";

export type ListedModel = {
  id: string;
  object: "model";
  owned_by: string;
  display_name: string;
  created?: number;
  created_at?: string;
  type?: "model";
  provider_model_ref?: string;
  apiBackend?: "responses";
  maxRetries?: 0;
  supportsReasoning?: boolean;
  supportsTools?: boolean;
  /** No token charge: OpenRouter :free, OpenCode Zen *-free, or a self-hosted box. */
  free?: boolean;
  supportsReasoningEffort?: boolean;
  inputModalities?: string[];
  contextWindow?: number;
  maxCompletionTokens?: number;
  reasoningEfforts?: string[];
  inferenceIdleTimeoutSecs?: number;
};

const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const DISCOVERED_CREATED_AT = "1970-01-01T00:00:00Z";
const RESPONSES_IDLE_TIMEOUT_SECONDS = 180;

function stripLocalProviderPrefix(raw: string): string {
  const prefix = `${PROVIDER_ID}/`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

const CATALOG_ALIASES = new Set([CATALOG_MODEL_ID, "auto", "catalog"]);

/** OpenCode sends this instead of a provider/model slug; Admin default + fallbacks apply. */
export function isCatalogAlias(raw: string): boolean {
  return CATALOG_ALIASES.has(stripLocalProviderPrefix(raw.trim()));
}

export function parseModelRef(raw: string, fallbackProvider?: string): ModelRef {
  const trimmed = stripLocalProviderPrefix(raw.trim());
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const providerId = trimmed.slice(0, slash);
    const model = trimmed.slice(slash + 1);
    if (providerById(providerId) && model) {
      return { providerId, model, slug: `${providerId}/${model}` };
    }
  }
  if (fallbackProvider) {
    return { providerId: fallbackProvider, model: trimmed, slug: `${fallbackProvider}/${trimmed}` };
  }
  throw new Error(
    `Unrecognized model '${raw}'. Use provider/model, e.g. groq/llama-3.3-70b-versatile.`
  );
}

export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) return trimmed;
  if (trimmed.endsWith("/openai")) return `${trimmed}/v1`;
  return `${trimmed}/v1`;
}

export function providerBaseUrl(settings: Settings, provider: ProviderDescriptor): string {
  const extra = settings.extra[provider.id] ?? {};
  if (provider.id === "cloudflare") {
    const accountId = extra.accountId?.trim();
    if (!accountId) throw new Error("Cloudflare requires an account ID");
    return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
  }
  const override = extra.baseUrl?.trim();
  if (override) return normalizeBaseUrl(override);
  if (provider.defaultBaseUrl) return normalizeBaseUrl(provider.defaultBaseUrl);
  throw new Error(`${provider.name} has no base URL configured`);
}

export function providerApiKey(settings: Settings, provider: ProviderDescriptor): string {
  if (provider.staticKey) return provider.staticKey;
  const key = settings.keys[provider.id]?.trim();
  if (key) return key;
  throw new Error(`${provider.name} has no API key configured`);
}

export function listedModel(
  providerId: string,
  model: string,
  displayName: string,
  view: CatalogView = "default"
): ListedModel {
  const id = `${providerId}/${model}`;
  const row: ListedModel = {
    id,
    object: "model",
    owned_by: providerId,
    display_name: displayName,
    created: 0,
    created_at: DISCOVERED_CREATED_AT,
    type: "model",
    provider_model_ref: id,
    supportsReasoning: true,
    supportsTools: true,
    free: Boolean(providerById(providerId)?.local) || isFreeModelId(model),
    inputModalities: ["text"],
  };
  if (view === "responses") {
    row.apiBackend = "responses";
    row.maxRetries = 0;
    row.supportsReasoningEffort = true;
    row.reasoningEfforts = REASONING_EFFORTS;
    row.inferenceIdleTimeoutSecs = RESPONSES_IDLE_TIMEOUT_SECONDS;
  }
  return row;
}

export function preferDefaultModel(
  models: ListedModel[],
  defaultSlug: string | null
): ListedModel[] {
  const copy = models.slice();
  copy.sort((a, b) => {
    const af = a.free ? 1 : 0;
    const bf = b.free ? 1 : 0;
    if (af !== bf) return bf - af;
    return a.id.localeCompare(b.id);
  });
  if (!defaultSlug) return copy;
  const idx = copy.findIndex(
    (model) => model.id === defaultSlug || model.provider_model_ref === defaultSlug
  );
  if (idx <= 0) return copy;
  const [hit] = copy.splice(idx, 1);
  return [hit, ...copy];
}

export function parseCatalogView(raw: string | null): CatalogView {
  if (raw === "responses" || raw === "messages") return raw;
  return "default";
}

export type ModelListing = {
  id: string;
  /** true/false from provider metadata; null if the list did not say. */
  supportsTools: boolean | null;
  free?: boolean;
};

/** OpenCode Zen stealth/free leaves that do not use a -free suffix. */
const FREE_MODEL_LEAVES = new Set(["big-pickle", "gpt-5-nano"]);

export function isFreeModelId(id: string): boolean {
  const n = id.trim().toLowerCase();
  if (!n) return false;
  if (n.endsWith(":free") || n.endsWith("-free") || n.endsWith("/free")) return true;
  const leaf = n.split("/").pop() ?? n;
  return FREE_MODEL_LEAVES.has(leaf);
}

export function listingIsFree(row: Record<string, unknown>, id: string): boolean {
  if (isFreeModelId(id)) return true;
  const pricing = row.pricing;
  if (pricing && typeof pricing === "object" && !Array.isArray(pricing)) {
    const prompt = (pricing as { prompt?: unknown }).prompt;
    if (prompt === 0 || prompt === "0" || prompt === "0.0") return true;
  }
  return false;
}

const NON_TOOL_MODEL =
  /embed(?:ding|qa)?|rerank(?:qa)?|whisper|tts\b|transcri|moderation|dall-e|dalle|flux|imagen|vocoder|\basr\b|wav2vec|kokoro|nomic-embed|bge-|mxbai|stable-diffusion|sdxl|sound-?gen/i;

export function isNonToolModelId(id: string): boolean {
  return NON_TOOL_MODEL.test(id);
}

export function toolsSupportFromListing(row: Record<string, unknown>): boolean | null {
  const params = row.supported_parameters ?? row.supportedParameters;
  if (Array.isArray(params)) {
    const names = params.map((value) => String(value).toLowerCase());
    return names.includes("tools") || names.includes("tool_choice") || names.includes("functions");
  }
  const capabilities = row.capabilities;
  if (Array.isArray(capabilities)) {
    const names = capabilities.map((value) => String(value).toLowerCase());
    if (
      names.includes("tools") ||
      names.includes("function_calling") ||
      names.includes("functions")
    ) {
      return true;
    }
  } else if (capabilities && typeof capabilities === "object") {
    const caps = capabilities as Record<string, unknown>;
    if (caps.tools === true || caps.function_calling === true || caps.functions === true)
      return true;
    if (caps.tools === false && caps.function_calling === false) return false;
  }
  if (row.supports_tools === true || row.supportsTools === true) return true;
  if (row.supports_tools === false || row.supportsTools === false) return false;
  return null;
}

/** Drop embeddings/audio/image, and anything the provider said cannot take tools. */
export function keepToolCapableModel(listing: ModelListing): boolean {
  if (!listing.id.trim()) return false;
  if (isNonToolModelId(listing.id)) return false;
  if (listing.supportsTools === false) return false;
  return true;
}

export function listedModelsForProvider(
  settings: Settings,
  provider: ProviderDescriptor
): string[] {
  const discovered = settings.discovered[provider.id];
  const raw = discovered && discovered.length > 0 ? discovered : provider.defaultModels;
  return raw.filter((id) => keepToolCapableModel({ id, supportsTools: null }));
}

export function defaultListedModels(
  settings: Settings,
  view: CatalogView = "default"
): ListedModel[] {
  const out: ListedModel[] = [];
  for (const provider of allProviders()) {
    if (!isProviderReady(settings, provider.id)) continue;
    for (const model of listedModelsForProvider(settings, provider)) {
      out.push(listedModel(provider.id, model, `${provider.name} / ${model}`, view));
    }
  }
  return preferDefaultModel(out, settings.model);
}

type OpenAIModelList = {
  data?: Array<Record<string, unknown> & { id?: string }>;
};

function modelsListUrl(settings: Settings, provider: ProviderDescriptor): string {
  const base = `${providerBaseUrl(settings, provider)}/models`;
  return provider.modelsQuery ? `${base}?${provider.modelsQuery}` : base;
}

function listingsFromOpenAiBody(body: OpenAIModelList): ModelListing[] {
  return (body.data ?? [])
    .map((row) => {
      const id = typeof row.id === "string" ? row.id : "";
      return {
        id,
        supportsTools: toolsSupportFromListing(row),
        free: listingIsFree(row, id),
      };
    })
    .filter((row) => keepToolCapableModel(row))
    .sort((a, b) => Number(Boolean(b.free)) - Number(Boolean(a.free)) || a.id.localeCompare(b.id));
}

async function discoverOpenAiModels(
  settings: Settings,
  provider: ProviderDescriptor,
  fetchImpl: typeof fetch
): Promise<string[]> {
  const apiKey = providerApiKey(settings, provider);
  const url = modelsListUrl(settings, provider);
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error(`${provider.name} model list failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as OpenAIModelList;
  return listingsFromOpenAiBody(body).map((row) => row.id);
}

export async function discoverProviderModels(
  settings: Settings,
  provider: ProviderDescriptor,
  fetchImpl: typeof fetch = fetch
): Promise<string[]> {
  let openaiError: Error | null = null;
  try {
    const ids = await discoverOpenAiModels(settings, provider, fetchImpl);
    if (ids.length > 0) return ids;
  } catch (error) {
    openaiError = error instanceof Error ? error : new Error(String(error));
    if (!isOllamaFamily(provider)) throw openaiError;
  }
  if (isOllamaFamily(provider)) {
    try {
      const tags = await discoverOllamaToolModels(providerBaseUrl(settings, provider), fetchImpl);
      if (tags.length > 0) return tags;
    } catch (error) {
      throw openaiError ?? (error instanceof Error ? error : new Error(String(error)));
    }
  }
  const cached = listedModelsForProvider(settings, provider);
  if (cached.length > 0) return cached;
  if (openaiError) throw openaiError;
  return [];
}

type OllamaTagList = {
  models?: Array<{ name?: string; model?: string }>;
};

async function discoverOllamaTags(
  openaiBaseUrl: string,
  fetchImpl: typeof fetch
): Promise<string[]> {
  const root = openaiBaseUrl.replace(/\/v1$/i, "");
  const response = await fetchImpl(`${root}/api/tags`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) {
    throw new Error(`Ollama /api/tags failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as OllamaTagList;
  return (body.models ?? [])
    .map((row) => row.name || row.model)
    .filter((id): id is string => Boolean(id));
}

type OllamaShow = {
  template?: string;
  capabilities?: unknown;
};

async function ollamaModelSupportsTools(
  root: string,
  name: string,
  fetchImpl: typeof fetch
): Promise<boolean | null> {
  try {
    const response = await fetchImpl(`${root}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as OllamaShow;
    const caps = body.capabilities;
    if (Array.isArray(caps)) {
      return caps.map((value) => String(value).toLowerCase()).includes("tools");
    }
    const template = String(body.template ?? "");
    if (!template) return null;
    return /\.Tools\b/.test(template);
  } catch {
    return null;
  }
}

async function discoverOllamaToolModels(
  openaiBaseUrl: string,
  fetchImpl: typeof fetch
): Promise<string[]> {
  const names = (await discoverOllamaTags(openaiBaseUrl, fetchImpl)).filter((id) =>
    keepToolCapableModel({ id, supportsTools: null })
  );
  const root = openaiBaseUrl.replace(/\/v1$/i, "");
  const kept: string[] = [];
  for (const name of names) {
    const tools = await ollamaModelSupportsTools(root, name, fetchImpl);
    if (keepToolCapableModel({ id: name, supportsTools: tools })) kept.push(name);
  }
  return kept;
}

export type ProbeResult = {
  ok: boolean;
  providerId: string;
  baseUrl: string;
  models: string[];
  error?: string;
};

export async function probeProvider(
  settings: Settings,
  provider: ProviderDescriptor,
  fetchImpl: typeof fetch = fetch
): Promise<ProbeResult> {
  let baseUrl: string;
  try {
    baseUrl = providerBaseUrl(settings, provider);
  } catch (error) {
    return {
      ok: false,
      providerId: provider.id,
      baseUrl: provider.defaultBaseUrl ?? "",
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const models = await discoverProviderModels(settings, provider, fetchImpl);
    return { ok: true, providerId: provider.id, baseUrl, models };
  } catch (error) {
    return {
      ok: false,
      providerId: provider.id,
      baseUrl,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function buildModelCatalog(
  settings: Settings,
  fetchImpl: typeof fetch = fetch,
  view: CatalogView = "default"
): Promise<ListedModel[]> {
  const seen = new Set<string>();
  const out: ListedModel[] = [];
  const push = (model: ListedModel): void => {
    if (seen.has(model.id)) return;
    seen.add(model.id);
    out.push(model);
  };

  for (const provider of allProviders()) {
    if (!isProviderReady(settings, provider.id)) continue;
    let models = listedModelsForProvider(settings, provider);
    try {
      models = await discoverProviderModels(settings, provider, fetchImpl);
    } catch {
      models = listedModelsForProvider(settings, provider);
    }
    for (const model of models) {
      push(listedModel(provider.id, model, `${provider.name} / ${model}`, view));
    }
  }
  return preferDefaultModel(out, settings.model);
}

export function modelsListPayload(models: ListedModel[]): {
  object: "list";
  data: ListedModel[];
  first_id: string | null;
  has_more: false;
  last_id: string | null;
} {
  return {
    object: "list",
    data: models,
    first_id: models[0]?.id ?? null,
    has_more: false,
    last_id: models[models.length - 1]?.id ?? null,
  };
}
