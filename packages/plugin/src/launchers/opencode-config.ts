import { CATALOG_MODEL_ID, OPENCODE_LAUNCHER_TOKEN_ENV, PROVIDER_ID } from "../paths.js";
import { proxyV1Url } from "./common.js";
import type { ClientModel } from "./client-models.js";

export const OPENCODE_API_KEY_ENV = OPENCODE_LAUNCHER_TOKEN_ENV;

export type OpenCodeProcessConfig = {
  file: Record<string, unknown>;
  overlay: Record<string, unknown>;
};

export function catalogClientModel(): ClientModel {
  return {
    wireSlug: CATALOG_MODEL_ID,
    providerModelRef: `${PROVIDER_ID}/${CATALOG_MODEL_ID}`,
    displayName: "Free OpenCode",
    supportsReasoning: true,
    inputModalities: ["text"],
    contextWindowTokens: null,
    maxOutputTokens: null,
  };
}

export function modelConfigEntry(model: ClientModel): Record<string, unknown> {
  const config: Record<string, unknown> = {
    name: model.displayName,
    reasoning: model.supportsReasoning !== false,
  };
  if (model.inputModalities) {
    config.modalities = { input: model.inputModalities };
  }
  if (model.contextWindowTokens != null || model.maxOutputTokens != null) {
    config.limit = {
      context: model.contextWindowTokens ?? 0,
      output: model.maxOutputTokens ?? 0,
    };
  }
  return config;
}

export function buildOpenCodeConfig(
  models: ClientModel[],
  proxyRootUrl: string,
  options: { apiKey?: string } = {}
): OpenCodeProcessConfig {
  if (models.length === 0) {
    throw new Error("OpenCode requires at least one routable Free OpenCode model");
  }
  const catalog = catalogClientModel();
  const modelConfig: Record<string, unknown> = {
    [catalog.wireSlug]: modelConfigEntry(catalog),
  };
  const apiKey = options.apiKey ?? `{env:${OPENCODE_API_KEY_ENV}}`;
  const providerConfig = {
    name: "Free OpenCode",
    npm: "@ai-sdk/openai",
    options: {
      baseURL: proxyV1Url(proxyRootUrl),
      apiKey,
    },
  };
  const defaultModel = `${PROVIDER_ID}/${CATALOG_MODEL_ID}`;
  return {
    file: {
      provider: {
        [PROVIDER_ID]: {
          ...providerConfig,
          models: modelConfig,
        },
      },
    },
    overlay: {
      provider: { [PROVIDER_ID]: providerConfig },
      enabled_providers: [PROVIDER_ID],
      disabled_providers: ["opencode"],
      model: defaultModel,
      small_model: defaultModel,
    },
  };
}

export function buildOpenCodeLauncherEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: {
    proxyRootUrl: string;
    authToken: string;
    configPath: string;
    overlay: Record<string, unknown>;
  }
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (
      key.startsWith("FOC_OPENCODE_") ||
      key === "OPENCODE_CONFIG" ||
      key === "OPENCODE_CONFIG_CONTENT"
    ) {
      continue;
    }
    env[key] = value;
  }
  env.OPENCODE_CONFIG = options.configPath;
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(options.overlay);
  env[OPENCODE_API_KEY_ENV] = options.authToken;
  env.NO_PROXY = env.NO_PROXY ? `${env.NO_PROXY},127.0.0.1,localhost` : "127.0.0.1,localhost";
  return env;
}
