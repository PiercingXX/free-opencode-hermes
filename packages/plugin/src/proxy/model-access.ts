/**
 * Learned model accessibility (paywall vs open) from live hops and probes.
 *
 * Gateways like B.ai mix free promo models with deposit/balance-locked ids in
 * one /models list with no pricing. We probe a small candidate set with a real
 * chat call, remember what answered, and only auto-route probed-open models.
 */

import type { Settings } from "../config/settings.js";
import { providerById } from "../providers/catalog.js";
import {
  listedModelsForProvider,
  parseModelRef,
  providerApiKey,
  providerBaseUrl,
} from "./models.js";

export type ModelAccessStatus = "open" | "paywall" | "unknown";

export type ModelAccessEntry = {
  status: ModelAccessStatus;
  /** Unix ms when we last observed this. */
  at: number;
  reason?: string;
};

export type ModelAccessMap = Record<string, ModelAccessEntry>;

/** B.ai candidates worth probing — never auto-routed until a probe marks open. */
export const BAI_PROBE_CANDIDATES = [
  "glm-5.3-flash",
  "qwen3.8-flash",
  "hy3",
  "mimo-v2.5",
] as const;

/** DeepSeek flash is often listed with free promos but charges zero-balance keys. */
const BAI_PROBE_SKIP = new Set(["deepseek-v4.1-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]);

export const ACCESS_PROBE_MAX_TOKENS = 4;
export const ACCESS_PROBE_TIMEOUT_MS = 12_000;
/** Keep at 1 — parallel probes burn B.ai concurrency and 429 the real chat. */
export const ACCESS_PROBE_CONCURRENCY = 1;
/** Re-probe when no open model is fresher than this. */
export const ACCESS_PROBE_STALE_MS = 6 * 60 * 60 * 1000;

/** Classify an upstream chat/completions outcome for access learning. */
export function classifyAccessStatus(
  status: number,
  message = ""
): ModelAccessStatus | null {
  const text = message.toLowerCase();
  if (
    /deposit|access restricted|premium|unlock|purchase|billing|payment|credit insufficient|insufficient (credit|balance)|balance\s*=\s*0|required=\d+/.test(
      text
    )
  ) {
    return "paywall";
  }
  // Reachable: success or rate limit (still accepted by the gateway).
  if (status === 200 || status === 429) return "open";
  // B.ai rejects max_tokens<=2 before authz — that means the model is reachable.
  if (status === 400 && /max_tokens|must be greater/.test(text)) return "open";
  if (status === 402 || status === 403) return "paywall";
  return null;
}

/** True when the upstream refusal is billing/paywall (hop; do not end the turn). */
export function isPaywallMessage(status: number, message = ""): boolean {
  return classifyAccessStatus(status, message) === "paywall";
}

export function rememberedAccess(settings: Settings, slug: string): ModelAccessStatus {
  return settings.modelAccess?.[slug]?.status ?? "unknown";
}

export function rememberAccess(
  settings: Settings,
  slug: string,
  status: ModelAccessStatus,
  reason?: string
): Settings {
  if (status === "unknown") return settings;
  const prev = settings.modelAccess?.[slug];
  if (prev?.status === status && (!reason || prev.reason === reason)) {
    return {
      ...settings,
      modelAccess: {
        ...(settings.modelAccess ?? {}),
        [slug]: { ...prev, at: Date.now(), ...(reason ? { reason: reason.slice(0, 240) } : {}) },
      },
    };
  }
  return {
    ...settings,
    modelAccess: {
      ...(settings.modelAccess ?? {}),
      [slug]: {
        status,
        at: Date.now(),
        ...(reason ? { reason: reason.slice(0, 240) } : {}),
      },
    },
  };
}

export function parseModelAccessMap(raw: unknown): ModelAccessMap {
  const out: ModelAccessMap = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [slug, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!slug.trim() || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const status = row.status;
    if (status !== "open" && status !== "paywall" && status !== "unknown") continue;
    const at = typeof row.at === "number" && Number.isFinite(row.at) ? row.at : Date.now();
    const reason =
      typeof row.reason === "string" && row.reason.trim()
        ? row.reason.trim().slice(0, 240)
        : undefined;
    out[slug] = { status, at, ...(reason ? { reason } : {}) };
  }
  return out;
}

export function providerNeedsAccessProbe(settings: Settings, providerId: string): boolean {
  const base = providerId.split("@")[0] ?? providerId;
  if (base !== "bai") return false;
  const now = Date.now();
  const freshOpen = Object.entries(settings.modelAccess ?? {}).some(
    ([slug, entry]) =>
      slug.startsWith(`${providerId}/`) &&
      entry.status === "open" &&
      now - entry.at < ACCESS_PROBE_STALE_MS
  );
  return !freshOpen;
}

/** Probe candidate list: known likely-free ∩ discovered, minus known skip/paywall. */
export function accessProbeCandidates(settings: Settings, providerId: string): string[] {
  const provider = providerById(providerId);
  if (!provider) return [];
  const listed = new Set(listedModelsForProvider(settings, provider));
  const admin = [settings.model, ...(settings.fallbacks ?? [])]
    .map((raw) => {
      if (!raw) return null;
      try {
        const ref = parseModelRef(raw);
        return ref.baseProviderId === providerId || ref.providerId === providerId ? ref.model : null;
      } catch {
        return null;
      }
    })
    .filter((m): m is string => Boolean(m));

  const hints =
    providerId === "bai" || providerId.startsWith("bai@")
      ? [...BAI_PROBE_CANDIDATES, ...admin]
      : [...admin, ...provider.defaultModels];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const model of hints) {
    const leaf = model.trim();
    if (!leaf || seen.has(leaf)) continue;
    if (BAI_PROBE_SKIP.has(leaf.toLowerCase())) continue;
    if (listed.size > 0 && !listed.has(leaf)) continue;
    const slug = `${providerId}/${leaf}`;
    if (rememberedAccess(settings, slug) === "paywall") continue;
    seen.add(leaf);
    out.push(leaf);
  }
  return out.slice(0, 8);
}

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

async function mapPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const queue = items.slice();
  const runners = Array.from({ length: Math.min(concurrency, Math.max(queue.length, 1)) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export type AccessProbeResult = {
  settings: Settings;
  probed: Array<{ slug: string; status: ModelAccessStatus; httpStatus: number; message: string }>;
};

/**
 * Hardened live probe: tiny chat completions against candidate models.
 * Only marks open on 200/429 (or max_tokens validation). Paywall/balance
 * errors are remembered and excluded from auto-routing.
 */
export async function probeProviderAccess(
  settings: Settings,
  providerId: string,
  options?: { force?: boolean; signal?: AbortSignal; fetchImpl?: typeof fetch }
): Promise<AccessProbeResult> {
  const provider = providerById(providerId);
  if (!provider) return { settings, probed: [] };
  if (!options?.force && !providerNeedsAccessProbe(settings, providerId)) {
    return { settings, probed: [] };
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  const candidates = accessProbeCandidates(settings, providerId);
  let live = settings;
  const probed: AccessProbeResult["probed"] = [];

  await mapPool(candidates, ACCESS_PROBE_CONCURRENCY, async (model) => {
    if (options?.signal?.aborted) return;
    const slug = `${providerId}/${model}`;
    try {
      const baseUrl = providerBaseUrl(live, provider);
      const apiKey = providerApiKey(live, provider);
      // Always bound by probe timeout; optionally also honor caller abort.
      const timeout = AbortSignal.timeout(ACCESS_PROBE_TIMEOUT_MS);
      const signal =
        options?.signal && typeof AbortSignal.any === "function"
          ? AbortSignal.any([options.signal, timeout])
          : timeout;
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "." }],
          max_tokens: ACCESS_PROBE_MAX_TOKENS,
        }),
        signal,
      });
      const message = await readErrorMessage(response);
      const access = classifyAccessStatus(response.status, message);
      probed.push({
        slug,
        status: access ?? "unknown",
        httpStatus: response.status,
        message,
      });
      if (access) {
        const reason =
          access === "open"
            ? `probe http ${response.status}`
            : message.slice(0, 240);
        // Serialize writes — concurrent workers must not clobber each other.
        live = rememberAccess(live, slug, access, reason);
      }
    } catch (error) {
      probed.push({
        slug,
        status: "unknown",
        httpStatus: 0,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return { settings: live, probed };
}

/** Providers that must be live-probed before free-first auto-routing. */
export function providersNeedingAccessProbe(settings: Settings): string[] {
  return ["bai"].filter((id) => {
    try {
      // ready check deferred to caller; we only know probe policy here
      return providerNeedsAccessProbe(settings, id);
    } catch {
      return false;
    }
  });
}
