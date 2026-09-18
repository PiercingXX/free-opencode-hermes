import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AuthHook } from "@opencode-ai/plugin";

import {
  applyEnvOverrides,
  loadSettings,
  saveSettings,
  setProviderKey,
} from "../config/settings.js";
import { PROVIDER_ID } from "../paths.js";
import { PROVIDER_CATALOG, providerById } from "../providers/catalog.js";

/** OpenCode v2 stores connected keys here; without this entry the TUI shows "No provider selected". */
export function opencodeAuthPath(home = homedir()): string {
  return join(home, ".local", "share", "opencode", "auth.json");
}

/** Merge the proxy token so OpenCode treats free-opencode as a connected provider. */
export function ensureFreeOpenCodeAuth(token: string, home = homedir()): void {
  const key = token.trim();
  if (!key) return;
  const path = opencodeAuthPath(home);
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    current = {};
  }
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
  mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
