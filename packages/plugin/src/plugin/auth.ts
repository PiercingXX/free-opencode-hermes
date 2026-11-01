import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AuthHook } from "@opencode-ai/plugin";

import {
  applyEnvOverrides,
  loadSettings,
  saveSettings,
  setProviderKey,
} from "../config/settings.js";
import { writeFileAtomic } from "../fs-atomic.js";
import { PROVIDER_ID } from "../paths.js";
import { PROVIDER_CATALOG, providerById } from "../providers/catalog.js";

/** OpenCode v2 stores connected keys here; without this entry the TUI shows "No provider selected". */
export function opencodeAuthPath(home = homedir()): string {
  return join(home, ".local", "share", "opencode", "auth.json");
}

export type OpenCodeAuthState =
  | { state: "missing"; path: string }
  | { state: "ok"; path: string; data: Record<string, unknown> }
  | { state: "invalid"; path: string; error: string };

/** Read OpenCode's auth.json without ever treating a broken file as empty. */
export function readOpenCodeAuth(home = homedir()): OpenCodeAuthState {
  const path = opencodeAuthPath(home);
  if (!existsSync(path)) return { state: "missing", path };
  try {
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return { state: "ok", path, data: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { state: "invalid", path, error: "top level is not a JSON object" };
    }
    return { state: "ok", path, data: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      state: "invalid",
      path,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Merge the proxy token so OpenCode treats free-opencode as a connected provider.
 * Other providers' credentials are preserved; an unparseable auth.json is left
 * untouched (throws) rather than being replaced with just our entry.
 */
export function ensureFreeOpenCodeAuth(token: string, home = homedir()): void {
  const key = token.trim();
  if (!key) return;
  const auth = readOpenCodeAuth(home);
  if (auth.state === "invalid") {
    throw new Error(
      `${auth.path} is not valid JSON (${auth.error}); not rewriting it so other provider ` +
        "credentials are kept. Fix or move the file, then restart OpenCode."
    );
  }
  const current = auth.state === "ok" ? { ...auth.data } : {};
  const existing = current[PROVIDER_ID];
  if (
    existing &&
    typeof existing === "object" &&
    !Array.isArray(existing) &&
    (existing as { key?: unknown }).key === key
  ) {
    return;
  }
  current[PROVIDER_ID] = { type: "api", key };
  writeFileAtomic(auth.path, `${JSON.stringify(current, null, 2)}\n`, 0o600);
}

export function buildAuthHook(): AuthHook {
  const connectable = PROVIDER_CATALOG.filter((p) => !p.local && !p.unsupported && p.env);
  return {
    provider: PROVIDER_ID,
    async loader(): Promise<Record<string, string>> {
      const settings = applyEnvOverrides(loadSettings());
      return { apiKey: settings.proxyAuthToken, key: settings.proxyAuthToken };
    },
    methods: [
      {
        type: "api",
        label: "Connect a provider API key",
        prompts: [
          {
            type: "select",
            key: "provider_id",
            message: "Which provider?",
            options: connectable.map((p) => ({
              label: p.name,
              value: p.id,
              hint: p.env,
            })),
          },
          {
            type: "text",
            key: "api_key",
            message: "API key",
            placeholder: "paste key",
          },
          {
            type: "text",
            key: "extra",
            message: "Extra (Azure base URL or Cloudflare account ID, if needed)",
            placeholder: "leave blank unless required",
          },
        ],
        async authorize(
          inputs
        ): Promise<{ type: "failed" } | { type: "success"; key: string; provider: string }> {
          const providerId = inputs?.provider_id?.trim();
          const apiKey = inputs?.api_key?.trim();
          if (!providerId || !apiKey) return { type: "failed" };
          const provider = providerById(providerId);
          if (!provider) return { type: "failed" };
          const extra: Record<string, string> = {};
          const extraValue = inputs?.extra?.trim();
          if (extraValue) {
            if (providerId === "azure_openai" || providerId === "bedrock")
              extra.baseUrl = extraValue;
            if (providerId === "cloudflare") extra.accountId = extraValue;
          }
          const settings = setProviderKey(
            applyEnvOverrides(loadSettings()),
            providerId,
            apiKey,
            extra
          );
          saveSettings(settings);
          return { type: "success", key: settings.proxyAuthToken, provider: PROVIDER_ID };
        },
      },
    ],
  };
}
