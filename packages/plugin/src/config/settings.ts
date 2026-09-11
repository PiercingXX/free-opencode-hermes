import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

import { DEFAULT_HOST, DEFAULT_PORT, settingsPath, stateDir } from "../paths.js";
import { allProviders, providerById } from "../providers/catalog.js";
import { suggestedBaseUrl, type FoundHost } from "../providers/inventory.js";
import { parseModelAccessMap, type ModelAccessMap } from "../proxy/model-access.js";

export type Account = {
  providerId: string;
  id: string;
  label?: string;
};

export type Settings = {
  version: 1;
  listen: { host: string; port: number };
  proxyAuthToken: string;
  proxyAuthEnabled: boolean;
  model: string | null;
  fallbacks: string[];
  keys: Record<string, string>;
  extra: Record<string, Record<string, string>>;
  enabled: Record<string, boolean>;
  /** Last successful model list from Connect / probe, keyed by provider id. */
  discovered: Record<string, string[]>;
  modelAccess: ModelAccessMap;
  foundHosts: FoundHost[];
  /** Optional named accounts per provider (compound provider@account ids). */
  accounts: Account[];
};

export function emptySettings(): Settings {
  return {
    version: 1,
    listen: { host: DEFAULT_HOST, port: DEFAULT_PORT },
    proxyAuthToken: randomBytes(24).toString("hex"),
    proxyAuthEnabled: true,
    model: null,
    fallbacks: [],
    keys: {},
    extra: {},
    enabled: {},
    discovered: {},
    modelAccess: {},
    foundHosts: [],
    accounts: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(asRecord(value))) {
    if (typeof v === "string" && v.trim()) out[k] = v;
  }
  return out;
}

function asNestedStringMap(value: unknown): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [k, v] of Object.entries(asRecord(value))) {
    out[k] = asStringMap(v);
  }
  return out;
}

const ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function asAccountList(value: unknown): Account[] {
  const out: Account[] = [];
  if (!Array.isArray(value)) return out;
  for (const row of value) {
    const rec = asRecord(row);
    const providerId = typeof rec.providerId === "string" ? rec.providerId.trim() : "";
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!providerId || !id || !ACCOUNT_ID_PATTERN.test(id)) continue;
    const label = typeof rec.label === "string" && rec.label.trim() ? rec.label.trim() : undefined;
    out.push({ providerId, id, ...(label ? { label } : {}) });
  }
  return out;
}

export function normalizeSettings(raw: unknown): Settings {
  const base = emptySettings();
  const obj = asRecord(raw);
  const listen = asRecord(obj.listen);
  const port = Number(listen.port);
  return {
    version: 1,
    listen: {
      host:
        typeof listen.host === "string" && listen.host.trim() ? listen.host.trim() : DEFAULT_HOST,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    },
    proxyAuthToken:
      typeof obj.proxyAuthToken === "string" && obj.proxyAuthToken.trim()
        ? obj.proxyAuthToken.trim()
        : base.proxyAuthToken,
    proxyAuthEnabled: obj.proxyAuthEnabled !== false,
    model: typeof obj.model === "string" && obj.model.trim() ? obj.model.trim() : null,
    fallbacks: Array.isArray(obj.fallbacks)
      ? obj.fallbacks.filter((v): v is string => typeof v === "string" && Boolean(v.trim()))
      : [],
    keys: asStringMap(obj.keys),
    extra: asNestedStringMap(obj.extra),
    enabled: Object.fromEntries(
      Object.entries(asRecord(obj.enabled)).map(([k, v]) => [k, v === true])
    ),
    discovered: Object.fromEntries(
      Object.entries(asRecord(obj.discovered)).map(([k, v]) => [
        k,
        Array.isArray(v)
          ? v.filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
          : [],
      ])
    ),
    modelAccess: parseModelAccessMap(obj.modelAccess),
    foundHosts: Array.isArray(obj.foundHosts)
      ? obj.foundHosts
          .map((row) => asFoundHost(row))
          .filter((row): row is FoundHost => row !== null)
      : [],
    accounts: asAccountList(obj.accounts),
  };
}

function asFoundHost(raw: unknown): FoundHost | null {
  const row = asRecord(raw);
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const baseUrl = typeof row.baseUrl === "string" ? row.baseUrl.trim() : "";
  const kind = typeof row.kind === "string" ? row.kind.trim() : "";
  const host = typeof row.host === "string" ? row.host.trim() : "";
  if (!id || !baseUrl || !kind) return null;
  const scope =
    row.scope === "loopback" || row.scope === "lan" || row.scope === "tailscale"
      ? row.scope
      : "lan";
  return {
    id,
    kind,
    scope,
    host,
    label:
      typeof row.label === "string" && row.label.trim() ? row.label.trim() : `${host} · ${kind}`,
    baseUrl,
    models: Array.isArray(row.models)
      ? row.models.filter(
          (name): name is string => typeof name === "string" && Boolean(name.trim())
        )
      : [],
  };
}

export function loadSettings(home?: string): Settings {
  const path = settingsPath(home);
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return normalizeSettings(parsed);
  } catch {
    const created = emptySettings();
    saveSettings(created, home);
    return created;
  }
}

export function saveSettings(settings: Settings, home?: string): void {
  const path = settingsPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(stateDir(home), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function applyEnvOverrides(settings: Settings): Settings {
  const next: Settings = {
    ...settings,
    keys: { ...settings.keys },
    extra: { ...settings.extra },
    enabled: { ...settings.enabled },
    discovered: { ...settings.discovered },
    modelAccess: { ...(settings.modelAccess ?? {}) },
    foundHosts: [...(settings.foundHosts ?? [])],
    accounts: [...(settings.accounts ?? [])],
  };
  for (const provider of allProviders()) {
    if (next.enabled[provider.id] === false) continue;
    // Account-qualified provider instances (`provider@account`) do not inherit
    // environment keys — a shared env var would collapse account isolation.
    if (provider.baseProviderId && provider.id.includes("@")) {
      if (provider.local && !next.extra[provider.id]?.baseUrl) {
        const hint = suggestedBaseUrl(provider.id);
        if (hint) next.extra[provider.id] = { ...next.extra[provider.id], baseUrl: hint };
      }
      continue;
    }
    if (provider.env) {
      const fromEnv = process.env[provider.env]?.trim();
      if (fromEnv && !next.keys[provider.id]) next.keys[provider.id] = fromEnv;
    }
    if (provider.baseUrlEnv) {
      const fromEnv = process.env[provider.baseUrlEnv]?.trim();
      if (fromEnv) {
        next.extra[provider.id] = { ...next.extra[provider.id], baseUrl: fromEnv };
      }
    }
    for (const field of provider.extra ?? []) {
      if (!field.env) continue;
      const fromEnv = process.env[field.env]?.trim();
      if (fromEnv) {
        next.extra[provider.id] = { ...next.extra[provider.id], [field.key]: fromEnv };
      }
    }
    if (provider.local && !next.extra[provider.id]?.baseUrl) {
      const hint = suggestedBaseUrl(provider.id);
      if (hint) next.extra[provider.id] = { ...next.extra[provider.id], baseUrl: hint };
    }
  }
  return next;
}

export function isProviderReady(settings: Settings, providerId: string): boolean {
  const provider = providerById(providerId);
  if (!provider || provider.unsupported) return false;
  if (settings.enabled[providerId] === false) return false;
  for (const field of provider.extra ?? []) {
    if (
      field.required &&
      !settings.extra[providerId]?.[field.key]?.trim() &&
      !provider.defaultBaseUrl
    ) {
      return false;
    }
  }
  if (provider.local) {
    if (settings.enabled[providerId] === true) return true;
    if (settings.extra[providerId]?.baseUrl?.trim()) return true;
    return false;
  }
  if (provider.staticKey) return true;
  const key = settings.keys[providerId]?.trim();
  if (!key) return false;
  for (const field of provider.extra ?? []) {
    if (field.required && !settings.extra[providerId]?.[field.key]?.trim()) return false;
  }
  return true;
}

export function readyProviderIds(settings: Settings): string[] {
  return allProviders()
    .filter((p) => isProviderReady(settings, p.id))
    .map((p) => p.id);
}

export function redactedSettings(settings: Settings): Record<string, unknown> {
  return {
    ...settings,
    proxyAuthToken: settings.proxyAuthToken ? "********" : "",
    keys: Object.fromEntries(Object.keys(settings.keys).map((id) => [id, "********"])),
  };
}

export function setProviderKey(
  settings: Settings,
  providerId: string,
  key: string,
  extra?: Record<string, string>
): Settings {
  // Auto-register an account entry for provider@account ids.
  const accounts = [...(settings.accounts ?? [])];
  const { provider } = splitAccountQualifier(providerId);
  if (isAccountQualified(providerId)) {
    const accountId = providerId.slice(provider.length + 1);
    if (!accounts.some((a) => a.providerId === provider && a.id === accountId)) {
      accounts.push({ providerId: provider, id: accountId });
    }
  }
  const next: Settings = {
    ...settings,
    keys: { ...settings.keys },
    extra: { ...settings.extra },
    enabled: { ...settings.enabled, [providerId]: true },
    discovered: { ...settings.discovered },
    accounts,
  };
  if (key.trim()) next.keys[providerId] = key.trim();
  if (extra && Object.keys(extra).length > 0) {
    const merged = { ...next.extra[providerId] };
    for (const [field, value] of Object.entries(extra)) {
      if (!value.trim()) delete merged[field];
      else merged[field] = value.trim();
    }
    next.extra[providerId] = merged;
  }
  if (!next.model) {
    const provider = providerById(providerId);
    const first = provider?.defaultModels[0];
    if (first) next.model = `${providerId}/${first}`;
  }
  return next;
}

export function connectProvider(
  settings: Settings,
  providerId: string,
  extra: Record<string, string>,
  discovered: string[]
): Settings {
  const provider = providerById(providerId);
  const key = settings.keys[providerId]?.trim() || provider?.staticKey || "local";
  const next = setProviderKey(settings, providerId, key, extra);
  next.discovered = { ...next.discovered, [providerId]: discovered };
  if (!next.model && discovered[0]) next.model = `${providerId}/${discovered[0]}`;
  return next;
}

export function providerOwnsSlug(providerId: string, slug: string): boolean {
  return slug === providerId || slug.startsWith(`${providerId}/`);
}

export function isProviderConfigured(settings: Settings, providerId: string): boolean {
  if (settings.enabled[providerId] === false) return false;
  if (settings.enabled[providerId] === true) return true;
  if (settings.keys[providerId]?.trim()) return true;
  if ((settings.discovered[providerId] ?? []).length > 0) return true;
  const extra = settings.extra[providerId] ?? {};
  return Object.values(extra).some((value) => Boolean(value?.trim()));
}

/** Local cards leave Admin after Remove until Autofind or Connect. Cloud cards stay. */
export function isAdminListed(settings: Settings, providerId: string): boolean {
  const provider = providerById(providerId);
  if (!provider) return false;
  if (!provider.local) return true;
  return settings.enabled[providerId] !== false;
}

export type AdminSettingsPatch = {
  model?: string | null;
  fallbacks?: unknown;
  keys?: unknown;
  extra?: unknown;
};

/** Apply routing/keys from Admin. Does not reconnect a provider the user removed. */
export function applyAdminSettingsPatch(settings: Settings, patch: AdminSettingsPatch): Settings {
  let next: Settings = {
    ...settings,
    keys: { ...settings.keys },
    extra: { ...settings.extra },
    enabled: { ...settings.enabled },
    discovered: { ...settings.discovered },
    foundHosts: [...(settings.foundHosts ?? [])],
    accounts: [...(settings.accounts ?? [])],
  };
  if (typeof patch.model === "string" || patch.model === null) {
    next.model = typeof patch.model === "string" && patch.model.trim() ? patch.model.trim() : null;
  }
  if (Array.isArray(patch.fallbacks)) {
    next.fallbacks = patch.fallbacks.filter(
      (v): v is string => typeof v === "string" && Boolean(v.trim())
    );
  }
  const keys = patch.keys;
  const extraPatch =
    patch.extra && typeof patch.extra === "object" && !Array.isArray(patch.extra)
      ? (patch.extra as Record<string, Record<string, string>>)
      : {};
  if (keys && typeof keys === "object" && !Array.isArray(keys)) {
    for (const [id, value] of Object.entries(keys as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) {
        next = setProviderKey(next, id, value, extraPatch[id] ?? {});
      }
    }
  }
  for (const [id, fields] of Object.entries(extraPatch)) {
    if (next.enabled[id] === false) continue;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) continue;
    const nextExtra = { ...next.extra[id] };
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value !== "string" || !value.trim()) delete nextExtra[key];
      else nextExtra[key] = value.trim();
    }
    if (Object.keys(nextExtra).length === 0) {
      const extra = { ...next.extra };
      delete extra[id];
      next.extra = extra;
    } else {
      next.extra = { ...next.extra, [id]: nextExtra };
    }
  }
  return next;
}

/** Drop a provider from routing. Inventory URL hints do not bring it back until Connect. */
export function removeProvider(settings: Settings, providerId: string): Settings {
  const keys = { ...settings.keys };
  delete keys[providerId];
  const extra = { ...settings.extra };
  delete extra[providerId];
  const discovered = { ...settings.discovered };
  delete discovered[providerId];
  const enabled = { ...settings.enabled, [providerId]: false };
  const fallbacks = settings.fallbacks.filter((slug) => !providerOwnsSlug(providerId, slug));
  let model = settings.model;
  if (model && providerOwnsSlug(providerId, model)) {
    model = fallbacks[0] ?? null;
  }
  const foundHosts = (settings.foundHosts ?? []).filter((host) => host.id !== providerId);
  // If this was an account-expanded provider (provider@account), drop its account entry too.
  const accounts = (settings.accounts ?? []).filter(
    (account) => `${account.providerId}@${account.id}` !== providerId
  );
  return {
    ...settings,
    keys,
    extra,
    discovered,
    enabled,
    fallbacks,
    model,
    foundHosts,
    accounts,
  };
}

/** True if the given provider id contains an @ account qualifier. */
export function isAccountQualified(providerId: string): boolean {
  return providerId.includes("@");
}

/** Split `provider@account` into `{ provider, account }`, or the bare provider. */
export function splitAccountQualifier(providerId: string): {
  provider: string;
  account: string | null;
} {
  const at = providerId.indexOf("@");
  if (at <= 0) return { provider: providerId, account: null };
  return { provider: providerId.slice(0, at), account: providerId.slice(at + 1) };
}

/** Build the compound id `provider@account`. */
export function accountProviderId(provider: string, account: string): string {
  return `${provider}@${account}`;
}

/**
 * Add a new account for a provider. Returns the compound provider id
 * (`provider@account`) and the updated settings. The id must be unique within
 * that provider and must be slug-safe.
 */
export function addAccount(
  settings: Settings,
  providerId: string,
  accountId: string,
  label?: string
): { settings: Settings; providerId: string } {
  const id = accountId.trim();
  if (!ACCOUNT_ID_PATTERN.test(id)) {
    throw new Error("accountId must be a slug: letters, digits, _ and -");
  }
  const accounts = [...(settings.accounts ?? [])];
  const existing = accounts.find((a) => a.providerId === providerId && a.id === id);
  if (existing) {
    // idempotent — update the label if provided
    if (label !== undefined && label.trim()) {
      return {
        settings: {
          ...settings,
          accounts: accounts.map((a) =>
            a.providerId === providerId && a.id === id ? { ...a, label: label.trim() } : a
          ),
        },
        providerId: accountProviderId(providerId, id),
      };
    }
    return { settings, providerId: accountProviderId(providerId, id) };
  }
  accounts.push({ providerId, id, ...(label?.trim() ? { label: label.trim() } : {}) });
  return {
    settings: { ...settings, accounts },
    providerId: accountProviderId(providerId, id),
  };
}

/** List the account ids configured for a provider. Empty array means default single-account. */
export function accountIdsFor(settings: Settings, providerId: string): string[] {
  return (settings.accounts ?? []).filter((a) => a.providerId === providerId).map((a) => a.id);
}

/** Whether an account id for a provider is already configured. */
export function accountIdExists(
  settings: Settings,
  providerId: string,
  accountId: string
): boolean {
  return (settings.accounts ?? []).some((a) => a.providerId === providerId && a.id === accountId);
}

/** Safe base id for a newly minted auto account (a2, a3, ...). */
export function nextAutoAccountId(settings: Settings, providerId: string): string {
  const existing = new Set(accountIdsFor(settings, providerId));
  let n = 2;
  while (existing.has(`a${n}`)) n += 1;
  return `a${n}`;
}
