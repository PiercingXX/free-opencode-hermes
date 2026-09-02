import { HERMES_LAUNCHER_KEY_PREFIX } from "../paths.js";
import { proxyV1Url } from "./common.js";
import type { ClientModel } from "./client-models.js";

export const HERMES_PROVIDER_PREFIX = "foc-";
export const HERMES_KEY_ENV_PREFIX = HERMES_LAUNCHER_KEY_PREFIX;

const AUXILIARY_TASKS = [
  "vision",
  "web_extract",
  "compression",
  "skills_hub",
  "approval",
  "mcp",
  "title_generation",
  "memory_query_rewrite",
  "tts_audio_tags",
  "triage_specifier",
  "kanban_decomposer",
  "profile_describer",
  "goal_judge",
  "curator",
  "monitor",
  "background_review",
  "moa_reference",
  "moa_aggregator",
] as const;

export type HermesManagedConfig = {
  config: Record<string, unknown>;
  providerKey: string;
  providerRef: string;
  keyEnv: string;
  selectedModel: string;
};

function modelOverride(model: ClientModel): Record<string, unknown> | null {
  const override: Record<string, unknown> = {};
  if (model.supportsReasoning != null) override.supports_reasoning = model.supportsReasoning;
  if (model.inputModalities) {
    override.supports_vision = model.inputModalities.includes("image");
  }
  if (model.contextWindowTokens != null) override.context_window = model.contextWindowTokens;
  if (model.maxOutputTokens != null) override.max_output_tokens = model.maxOutputTokens;
  return Object.keys(override).length > 0 ? override : null;
}

function auxiliaryTaskConfig(task: string, providerRef: string): Record<string, unknown> {
  const config: Record<string, unknown> = {
    provider: providerRef,
    model: "",
    base_url: "",
    api_key: "",
    extra_body: {},
    fallback_chain: [],
  };
  if (task === "title_generation") config.prefer_fast_model = false;
  return config;
}

export function buildHermesManagedConfig(
  models: ClientModel[],
  options: { proxyRootUrl: string; nonce: string; selectedModel?: string | null }
): HermesManagedConfig {
  if (models.length === 0) {
    throw new Error("Hermes requires at least one routable Free OpenCode model");
  }
  const nonce = options.nonce;
  if (!nonce || !/^[a-zA-Z0-9]+$/.test(nonce)) {
    throw new Error("Hermes configuration nonce must be alphanumeric");
  }
  const wireSlugs = models.map((model) => model.wireSlug);
  const activeModel = options.selectedModel || wireSlugs[0];
  if (!wireSlugs.includes(activeModel)) {
    throw new Error(`model is not in the Free OpenCode catalog: ${activeModel}`);
  }
  const providerKey = `${HERMES_PROVIDER_PREFIX}${nonce.toLowerCase()}`;
  const providerRef = `custom:${providerKey}`;
  const keyEnv = `${HERMES_KEY_ENV_PREFIX}${nonce.toUpperCase()}`;
  const auxiliary: Record<string, unknown> = {};
  for (const task of AUXILIARY_TASKS) {
    auxiliary[task] = auxiliaryTaskConfig(task, providerRef);
  }
  const modelOverrides: Record<string, unknown> = {};
  for (const model of models) {
    const override = modelOverride(model);
    if (override) modelOverrides[model.wireSlug] = override;
  }
  const listed: Record<string, Record<string, never>> = {};
  for (const slug of wireSlugs) listed[slug] = {};
  const config: Record<string, unknown> = {
    providers: {
      [providerKey]: {
        name: "Free OpenCode",
        api: proxyV1Url(options.proxyRootUrl),
        key_env: keyEnv,
        extra_headers: {
          Authorization: `Bearer \${${keyEnv}}`,
        },
        transport: "codex_responses",
        default_model: activeModel,
        models: listed,
        discover_models: false,
      },
    },
    model: {
      provider: providerRef,
      default: activeModel,
      base_url: "",
      api_key: "",
      api_mode: "codex_responses",
    },
    fallback_providers: [],
    fallback_model: [],
    auxiliary,
  };
  if (Object.keys(modelOverrides).length > 0) {
    config.model_overrides = { custom: modelOverrides };
  }
  return {
    config,
    providerKey,
    providerRef,
    keyEnv,
    selectedModel: activeModel,
  };
}

export function buildHermesLauncherEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: { managedDirectory: string; keyEnv: string; authToken: string }
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (
      key.startsWith(HERMES_KEY_ENV_PREFIX) ||
      key === "HERMES_MANAGED_DIR" ||
      key === "HERMES_INFERENCE_MODEL" ||
      key === "HERMES_INFERENCE_PROVIDER"
    ) {
      continue;
    }
    env[key] = value;
  }
  env.HERMES_MANAGED_DIR = options.managedDirectory;
  env[options.keyEnv] = options.authToken;
  env.NO_PROXY = env.NO_PROXY ? `${env.NO_PROXY},127.0.0.1,localhost` : "127.0.0.1,localhost";
  return env;
}
