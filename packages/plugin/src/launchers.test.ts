import assert from "node:assert/strict";
import test from "node:test";

import { clientModelsFromResponse } from "./launchers/client-models.js";
import {
  detachedHermesSurface,
  isHermesPassthrough,
  withoutRoutingOverrides,
} from "./launchers/hermes.js";
import { buildHermesLauncherEnv, buildHermesManagedConfig } from "./launchers/hermes-config.js";
import { isOpenCodePassthrough } from "./launchers/opencode.js";
import {
  OPENCODE_API_KEY_ENV,
  buildOpenCodeConfig,
  buildOpenCodeLauncherEnv,
} from "./launchers/opencode-config.js";
import { CATALOG_MODEL_ID, PROVIDER_ID } from "./paths.js";
import { parseModelRef, preferDefaultModel, listedModel } from "./proxy/models.js";
import { routeTargets, sanitizeChatPayload } from "./proxy/router.js";
import { emptySettings, setProviderKey } from "./config/settings.js";

const models = [
  {
    wireSlug: "nvidia_nim/nvidia/nemotron-3-super-120b-a12b",
    providerModelRef: "nvidia_nim/nvidia/nemotron-3-super-120b-a12b",
    displayName: "NVIDIA NIM / nvidia/nemotron-3-super-120b-a12b",
    supportsReasoning: true,
    inputModalities: ["text"],
    contextWindowTokens: null,
    maxOutputTokens: null,
  },
  {
    wireSlug: "groq/llama-3.3-70b-versatile",
    providerModelRef: "groq/llama-3.3-70b-versatile",
    displayName: "Groq / llama-3.3-70b-versatile",
    supportsReasoning: false,
    inputModalities: ["text", "image"],
    contextWindowTokens: 128000,
    maxOutputTokens: 8192,
  },
];

test("OpenCode process config uses Responses SDK and overlay-forces the model", () => {
  const config = buildOpenCodeConfig(models, "http://127.0.0.1:8082");
  const provider = (config.file.provider as Record<string, Record<string, unknown>>)[PROVIDER_ID];
  assert.equal(provider.npm, "@ai-sdk/openai");
  assert.equal((provider.options as { baseURL: string }).baseURL, "http://127.0.0.1:8082/v1");
  assert.equal((provider.options as { apiKey: string }).apiKey, `{env:${OPENCODE_API_KEY_ENV}}`);
  assert.deepEqual(config.overlay.enabled_providers, [PROVIDER_ID]);
  assert.deepEqual(config.overlay.disabled_providers, ["opencode"]);
  assert.equal(config.overlay.model, `${PROVIDER_ID}/${CATALOG_MODEL_ID}`);
  assert.equal(config.overlay.small_model, config.overlay.model);
  const advertised = Object.keys(provider.models as Record<string, unknown>);
  assert.deepEqual(advertised, [CATALOG_MODEL_ID]);
  assert.equal(config.overlay.agent, undefined);
});

test("catalog alias uses Admin default then fallbacks", () => {
  let settings = setProviderKey(emptySettings(), "groq", "k1");
  settings = setProviderKey(settings, "open_router", "k2");
  settings.model = "groq/llama-3.3-70b-versatile";
  settings.fallbacks = ["open_router/openrouter/free"];
  assert.deepEqual(
    routeTargets(settings, "default").map((ref) => ref.slug),
    ["groq/llama-3.3-70b-versatile", "open_router/openrouter/free"]
  );
  const fromAlias = routeTargets(settings, "free-opencode/default");
  assert.deepEqual(
    fromAlias.map((ref) => ref.slug),
    ["groq/llama-3.3-70b-versatile", "open_router/openrouter/free"]
  );
  const explicit = routeTargets(settings, "open_router/openrouter/free");
  assert.deepEqual(
    explicit.map((ref) => ref.slug),
    ["open_router/openrouter/free", "groq/llama-3.3-70b-versatile"]
  );
});

test("OpenCode launcher env is process-local and strips colliding config keys", () => {
  const env = buildOpenCodeLauncherEnv(
    {
      PATH: "/usr/bin",
      OPENCODE_CONFIG: "/tmp/user.json",
      OPENCODE_CONFIG_CONTENT: "{}",
      FOC_OPENCODE_STALE: "nope",
      HOME: "/home/x",
    },
    {
      proxyRootUrl: "http://127.0.0.1:8082",
      authToken: "tok",
      configPath: "/tmp/foc/opencode.json",
      overlay: { model: "free-opencode/groq/x" },
    }
  );
  assert.equal(env.OPENCODE_CONFIG, "/tmp/foc/opencode.json");
  assert.equal(env[OPENCODE_API_KEY_ENV], "tok");
  assert.equal(env.FOC_OPENCODE_STALE, undefined);
  assert.ok(env.OPENCODE_CONFIG_CONTENT?.includes("free-opencode/groq/x"));
  assert.equal(env.HOME, "/home/x");
});

test("Hermes managed config uses a nonce provider and codex_responses", () => {
  const managed = buildHermesManagedConfig(models, {
    proxyRootUrl: "http://127.0.0.1:8082",
    nonce: "deadbeef",
    selectedModel: "groq/llama-3.3-70b-versatile",
  });
  assert.equal(managed.providerKey, "foc-deadbeef");
  assert.equal(managed.providerRef, "custom:foc-deadbeef");
  assert.equal(managed.keyEnv, "FOC_HERMES_DEADBEEF");
  assert.equal(managed.selectedModel, "groq/llama-3.3-70b-versatile");
  const provider = (managed.config.providers as Record<string, Record<string, unknown>>)[
    "foc-deadbeef"
  ];
  assert.equal(provider.transport, "codex_responses");
  assert.equal(provider.api, "http://127.0.0.1:8082/v1");
  assert.equal(provider.discover_models, false);
  const model = managed.config.model as { api_mode: string; provider: string };
  assert.equal(model.api_mode, "codex_responses");
  assert.equal(model.provider, "custom:foc-deadbeef");
  const overrides = (
    managed.config.model_overrides as { custom: Record<string, { supports_vision: boolean }> }
  ).custom;
  assert.equal(overrides["groq/llama-3.3-70b-versatile"].supports_vision, true);
});

test("Hermes launcher env does not persist into the parent process map", () => {
  const env = buildHermesLauncherEnv(
    { PATH: "/bin", HERMES_MANAGED_DIR: "/old", FOC_HERMES_OLD: "x", HOME: "/h" },
    { managedDirectory: "/tmp/foc-hermes", keyEnv: "FOC_HERMES_AABB", authToken: "tok" }
  );
  assert.equal(env.HERMES_MANAGED_DIR, "/tmp/foc-hermes");
  assert.equal(env.FOC_HERMES_AABB, "tok");
  assert.equal(env.FOC_HERMES_OLD, undefined);
});

test("client model projection requires provider_model_ref", () => {
  const modelsFromCatalog = clientModelsFromResponse({
    object: "list",
    data: [
      {
        id: "groq/llama-3.3-70b-versatile",
        display_name: "Groq / llama",
        provider_model_ref: "groq/llama-3.3-70b-versatile",
        supportsReasoning: true,
        inputModalities: ["text"],
      },
      { id: "broken", display_name: "no ref" },
    ],
  });
  assert.equal(modelsFromCatalog.length, 1);
  assert.equal(modelsFromCatalog[0].wireSlug, "groq/llama-3.3-70b-versatile");
});

test("OpenCode passthrough skips the live proxy", () => {
  assert.equal(isOpenCodePassthrough(["--version"]), true);
  assert.equal(isOpenCodePassthrough(["auth", "login"]), true);
  assert.equal(isOpenCodePassthrough([]), false);
  assert.equal(isOpenCodePassthrough(["run", "fix tests"]), false);
});

test("Hermes attached vs detached vs passthrough", () => {
  assert.equal(isHermesPassthrough(["--help"]), true);
  assert.equal(isHermesPassthrough(["config", "get", "model"]), true);
  assert.equal(isHermesPassthrough([]), false);
  assert.equal(isHermesPassthrough(["chat"]), false);
  assert.equal(detachedHermesSurface(["gateway"]), true);
  assert.equal(detachedHermesSurface(["mcp", "serve"]), true);
  assert.equal(detachedHermesSurface(["chat"]), false);
});

test("Hermes --model is captured and stripped from the child argv", () => {
  const stripped = withoutRoutingOverrides(["chat", "-m", "groq/llama-3.3-70b-versatile", "--tui"]);
  assert.deepEqual(stripped.args, ["chat", "--tui"]);
  assert.equal(stripped.selectedModel, "groq/llama-3.3-70b-versatile");
});

test("parseModelRef strips the local free-opencode provider prefix", () => {
  const ref = parseModelRef("free-opencode/nvidia_nim/nvidia/nemotron-3-super-120b-a12b");
  assert.equal(ref.providerId, "nvidia_nim");
  assert.equal(ref.model, "nvidia/nemotron-3-super-120b-a12b");
});

test("catalog prefers the configured default model first", () => {
  const rows = [
    listedModel("groq", "llama-3.3-70b-versatile", "Groq / llama"),
    listedModel("nvidia_nim", "nvidia/nemotron-3-super-120b-a12b", "NIM / nemotron"),
  ];
  const ordered = preferDefaultModel(rows, "nvidia_nim/nvidia/nemotron-3-super-120b-a12b");
  assert.equal(ordered[0].id, "nvidia_nim/nvidia/nemotron-3-super-120b-a12b");
});

test("NIM thinking stays off unless Responses/chat asked for reasoning", () => {
  const off = sanitizeChatPayload({ model: "x", messages: [] }, "nvidia/nemotron", "nvidia_nim");
  assert.deepEqual(off.chat_template_kwargs, { enable_thinking: false });
  const on = sanitizeChatPayload(
    { model: "x", messages: [], reasoning_effort: "high" },
    "nvidia/nemotron",
    "nvidia_nim"
  );
  assert.equal(on.chat_template_kwargs, undefined);
});
