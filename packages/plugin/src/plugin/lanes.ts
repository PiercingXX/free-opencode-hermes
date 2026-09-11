import { isProviderReady, type Settings } from "../config/settings.js";
import { PROVIDER_ID } from "../paths.js";
import { allProviders, providerById } from "../providers/catalog.js";
import { listedModelsForProvider } from "../proxy/models.js";

export const LANE_AGENT_PREFIX = "lane-";

export type ParallelLane = {
  providerId: string;
  model: string;
  /** Upstream slug the proxy routes (`provider/model`). */
  slug: string;
  /** OpenCode agent model wire (`free-opencode/provider/model`). */
  wireModel: string;
  agentName: string;
  displayName: string;
  /** Higher = stronger worker. Orchestrator prefers the lowest score. */
  strength: number;
};

export function laneAgentName(providerId: string): string {
  return `${LANE_AGENT_PREFIX}${providerId}`;
}

export function isLaneAgentName(name: string): boolean {
  return name.startsWith(LANE_AGENT_PREFIX);
}

/**
 * Rough capacity score for weakest-orchestrator / strongest-worker assignment.
 * SGLang / large DeepSeek boxes outrank llama.cpp hosts with unknown sizes.
 */
export function laneStrength(providerId: string, model: string): number {
  const hay = `${providerId}/${model}`.toLowerCase();
  let score = 40;
  if (/sglang|deepseek|v4-flash|405b|70b|72b|120b/.test(hay)) score += 60;
  if (/32b|30b|34b|qwen3-coder-next/.test(hay)) score += 25;
  if (/14b|13b|8b|7b|3b|tq2|nano|mini|tiny/.test(hay)) score -= 20;
  if (/llamacpp|llama\.cpp|ollama/.test(hay)) score -= 5;
  if (/skippy|nagatha|brain/.test(hay)) score -= 5;
  return score;
}

/** Ready self-hosted boxes, one lane per discovered/default model (first model wins). */
export function listReadyLocalLanes(settings: Settings): ParallelLane[] {
  const out: ParallelLane[] = [];
  for (const provider of allProviders()) {
    if (!provider.local || !isProviderReady(settings, provider.id)) continue;
    const models = listedModelsForProvider(settings, provider);
    const model = models[0];
    if (!model) continue;
    const slug = `${provider.id}/${model}`;
    out.push({
      providerId: provider.id,
      model,
      slug,
      wireModel: `${PROVIDER_ID}/${slug}`,
      agentName: laneAgentName(provider.id),
      displayName: `${provider.name} / ${model}`,
      strength: laneStrength(provider.id, model),
    });
  }
  out.sort((a, b) => b.strength - a.strength || a.slug.localeCompare(b.slug));
  return out;
}

/** Weakest ready local — keeps orchestrator context light while workers use stronger boxes. */
export function pickOrchestratorLane(lanes: ParallelLane[]): ParallelLane | null {
  if (lanes.length === 0) return null;
  return [...lanes].sort((a, b) => a.strength - b.strength || a.slug.localeCompare(b.slug))[0]!;
}

export function isLocalClientModelSlug(wireSlug: string): boolean {
  const trimmed = wireSlug.trim();
  if (!trimmed || trimmed === "default" || trimmed === "auto" || trimmed === "catalog") {
    return false;
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return false;
  const providerId = trimmed.slice(0, slash);
  return Boolean(providerById(providerId)?.local);
}
