/**
 * Admin JSON API handlers (`/admin/api/*`). Transport, auth and error
 * mapping live in server.ts; each handler here gets a parsed request and
 * returns the JSON payload (or throws HttpError).
 */

import {
  addAccount,
  applyAdminSettingsPatch,
  applyEnvOverrides,
  connectProvider,
  isAdminListed,
  isProviderConfigured,
  isProviderReady,
  readyProviderIds,
  removeProvider,
  type Settings,
} from "../config/settings.js";
import { allProviders, providerById, providerExtraFields } from "../providers/catalog.js";
import { applyAutofindResults, runAutofind } from "../providers/autofind.js";
import { loadInventoryLanes, suggestedBaseUrl } from "../providers/inventory.js";
import { loadedConfigDefaultsToZen } from "../plugin/config.js";
import { openBreakers } from "./breaker.js";
import { activeCooldowns } from "./cooldown.js";
import { HttpError } from "./http.js";
import { probeProviderAccess } from "./model-access.js";
import { buildModelCatalog, probeProvider } from "./models.js";
import { currentLastRoute, readLogTail, recentRoutes } from "./route-log.js";
import type { SettingsStore } from "./settings-store.js";
import type { ProviderDescriptor } from "../providers/catalog.js";

export type AdminRequest = {
  store: SettingsStore;
  home: string;
  body: Record<string, unknown>;
  query: URLSearchParams;
};

export type AdminHandler = (req: AdminRequest) => Promise<unknown>;

/** Routing health shared by /health, /admin/api/state and /admin/api/last-route. */
export function routingHealth(): {
  cooldowns: Array<{ slug: string; providerId: string; availableAt: number; reason?: string }>;
  breakers: ReturnType<typeof openBreakers>;
} {
  return {
    cooldowns: activeCooldowns().map((c) => ({
      slug: c.slug,
      providerId: c.providerId,
      availableAt: c.availableAt,
      reason: c.reason,
    })),
    breakers: openBreakers(),
  };
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value.trim() : "";
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * The requested id is kept as-is: an unregistered `provider@account` resolves
 * to its base descriptor, but settings must be keyed by the qualified id.
 */
function requireProvider(body: Record<string, unknown>): {
  provider: ProviderDescriptor;
  providerId: string;
} {
  const providerId = stringField(body, "providerId");
  const provider = providerById(providerId);
  if (!provider) throw new HttpError(400, `Unknown provider '${providerId}'`);
  return { provider, providerId };
}

/**
 * Settings with the request's candidate key / extras layered on, for probing
 * a provider before (or without) saving. Never persisted directly.
 */
function probeOverlay(
  settings: Settings,
  providerId: string,
  body: Record<string, unknown>
): Settings {
  const overlay = applyEnvOverrides({
    ...settings,
    keys: { ...settings.keys },
    extra: { ...settings.extra },
  });
  const apiKey = stringField(body, "apiKey");
  if (apiKey) overlay.keys[providerId] = apiKey;
  overlay.extra[providerId] = { ...overlay.extra[providerId], ...stringMap(body.extra) };
  return overlay;
}

function catalogRow(settings: Settings, p: ProviderDescriptor): Record<string, unknown> {
  const accountQualified = Boolean(p.baseProviderId && p.id.includes("@"));
  return {
    id: p.id,
    name: p.name,
    env: p.env,
    local: Boolean(p.local),
    notes: p.notes ?? "",
    credentialUrl: p.credentialUrl,
    defaultBaseUrl: p.defaultBaseUrl ?? "",
    extra: providerExtraFields(p).map((field) => ({
      key: field.key,
      label: field.label,
      placeholder:
        field.placeholder ||
        (field.key === "baseUrl" ? suggestedBaseUrl(p.id) || p.defaultBaseUrl || "" : ""),
      required: Boolean(field.required),
      value: settings.extra[p.id]?.[field.key] ?? "",
    })),
    ready: isProviderReady(settings, p.id),
    configured: isProviderConfigured(settings, p.id),
    discovered: settings.discovered[p.id] ?? [],
    baseProviderId: p.baseProviderId,
    account: accountQualified ? { id: p.id.split("@")[1] ?? "", isAccount: true } : null,
  };
}

const state: AdminHandler = async ({ store, home }) => {
  const settings = store.get();
  return {
    listen: settings.listen,
    model: settings.model,
    fallbacks: settings.fallbacks,
    lastRoute: currentLastRoute(),
    recentRoutes: recentRoutes(),
    ...routingHealth(),
    zenDefault: loadedConfigDefaultsToZen(home),
    models: await buildModelCatalog(settings).catch(() => []),
    accounts: settings.accounts ?? [],
    catalog: allProviders()
      .filter((p) => isAdminListed(settings, p.id))
      .map((p) => catalogRow(settings, p)),
    inventory: loadInventoryLanes().map((lane) => ({
      providerId: lane.providerId,
      label: lane.label,
      endpoint: lane.endpoint,
      enabled: lane.enabled,
      kind: lane.kind,
      scope: lane.scope,
    })),
  };
};

const lastRoute: AdminHandler = async () => ({
  lastRoute: currentLastRoute(),
  recent: recentRoutes(),
  ...routingHealth(),
});

const log: AdminHandler = async ({ query, home }) => {
  const raw = Number(query.get("limit"));
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 500) : 50;
  return { limit, lines: await readLogTail(limit, home) };
};

const saveSettingsPatch: AdminHandler = async ({ store, body }) => {
  store.update((s) => applyAdminSettingsPatch(s, body));
  return { ok: true };
};

const probe: AdminHandler = async ({ store, body }) => {
  const { provider, providerId } = requireProvider(body);
  return probeProvider(probeOverlay(store.get(), providerId, body), provider);
};

const account: AdminHandler = async ({ store, body }) => {
  const providerId = stringField(body, "providerId");
  const accountId = stringField(body, "accountId");
  const label = stringField(body, "label") || undefined;
  if (!providerId || !accountId) throw new HttpError(400, "providerId and accountId are required");
  let result: ReturnType<typeof addAccount>;
  try {
    result = addAccount(store.get(), providerId, accountId, label);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
  const next = store.update(() => result.settings);
  return { ok: true, providerId: result.providerId, accounts: next.accounts };
};

const connect: AdminHandler = async ({ store, body }) => {
  const { provider, providerId } = requireProvider(body);
  const extra = stringMap(body.extra);
  // Probe outside the store: it awaits the network, and the store must not
  // hold a stale snapshot across that wait.
  const probed = await probeProvider(probeOverlay(store.get(), providerId, body), provider);
  if (!probed.ok) return probed;
  let next = store.update((s) =>
    connectProvider(probeOverlay(s, providerId, body), providerId, extra, probed.models)
  );
  if (providerId === "bai" || providerId.startsWith("bai@")) {
    const access = await probeProviderAccess(next, providerId, { force: true });
    store.learnAccess(access.settings.modelAccess);
    next = store.get();
  }
  return { ...probed, saved: true, model: next.model, modelAccess: next.modelAccess };
};

const autofind: AdminHandler = async ({ store }) => {
  const report = await runAutofind();
  // Synchronous from here: no await between reading and writing the store.
  const applied = applyAutofindResults(store.get(), report);
  const next = store.update(() => applied.settings);
  return {
    ok: true,
    hits: applied.report.hits,
    connected: applied.report.connected,
    notes: applied.report.notes,
    model: next.model,
  };
};

const remove: AdminHandler = async ({ store, body }) => {
  const { providerId } = requireProvider(body);
  const next = store.update((s) => removeProvider(s, providerId));
  return {
    ok: true,
    providerId,
    model: next.model,
    fallbacks: next.fallbacks,
    ready: readyProviderIds(next),
  };
};

/** Keyed by "METHOD /path". */
export const ADMIN_ROUTES: Record<string, AdminHandler> = {
  "GET /admin/api/state": state,
  "GET /admin/api/last-route": lastRoute,
  "GET /admin/api/log": log,
  "POST /admin/api/settings": saveSettingsPatch,
  "POST /admin/api/probe": probe,
  "POST /admin/api/account": account,
  "POST /admin/api/connect": connect,
  "POST /admin/api/autofind": autofind,
  "POST /admin/api/remove": remove,
};
