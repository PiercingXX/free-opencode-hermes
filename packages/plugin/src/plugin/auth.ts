import type { AuthHook } from "@opencode-ai/plugin";

import {
  applyEnvOverrides,
  loadSettings,
  saveSettings,
  setProviderKey,
} from "../config/settings.js";
import { PROVIDER_ID } from "../paths.js";
import { PROVIDER_CATALOG, providerById } from "../providers/catalog.js";

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
