import type { ListedModel } from "../proxy/models.js";

export type ClientModel = {
  wireSlug: string;
  providerModelRef: string;
  displayName: string;
  supportsReasoning: boolean | null;
  inputModalities: string[] | null;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
};

function nonemptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const stripped = value.trim();
  return stripped || null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function optionalPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function inputModalities(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const mods = value.filter((item): item is string => typeof item === "string" && Boolean(item));
  if (!mods.includes("text")) return null;
  return mods;
}

function providerModelRef(value: unknown): string | null {
  const ref = nonemptyString(value);
  if (!ref) return null;
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return ref;
}

export function clientModelsFromList(models: ListedModel[]): ClientModel[] {
  const seen = new Set<string>();
  const out: ClientModel[] = [];
  for (const item of models) {
    const wireSlug = nonemptyString(item.id);
    const ref = providerModelRef(item.provider_model_ref ?? item.id);
    if (!wireSlug || !ref || seen.has(wireSlug)) continue;
    seen.add(wireSlug);
    out.push({
      wireSlug,
      providerModelRef: ref,
      displayName: nonemptyString(item.display_name) || wireSlug,
      supportsReasoning: optionalBoolean(item.supportsReasoning),
      inputModalities: inputModalities(item.inputModalities),
      contextWindowTokens: optionalPositiveInt(item.contextWindow),
      maxOutputTokens: optionalPositiveInt(item.maxCompletionTokens),
    });
  }
  return out;
}

export function clientModelsFromResponse(payload: unknown): ClientModel[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("model list response was not a JSON object");
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return clientModelsFromList(data as ListedModel[]);
}

export async function fetchClientModels(
  proxyRootUrl: string,
  authToken: string,
  timeoutMs = 20000
): Promise<ClientModel[]> {
  const url = `${proxyRootUrl.replace(/\/+$/, "")}/v1/models?view=responses`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${authToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`/v1/models returned HTTP ${response.status}`);
  }
  return clientModelsFromResponse(await response.json());
}
