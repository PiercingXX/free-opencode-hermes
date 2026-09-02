import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyAdminSettingsPatch,
  applyEnvOverrides,
  connectProvider,
  emptySettings,
  isAdminListed,
  isProviderConfigured,
  isProviderReady,
  normalizeSettings,
  removeProvider,
  saveSettings,
  setProviderKey,
} from "./config/settings.js";
import {
  catalogIds,
  PROVIDER_CATALOG,
  providerById,
  providerExtraFields,
} from "./providers/catalog.js";
import { PROVIDER_ID } from "./paths.js";
import { restrictToFreeOpenCodeProvider } from "./plugin/config.js";
import {
  defaultListedModels,
  discoverProviderModels,
  isFreeModelId,
  isNonToolModelId,
  keepToolCapableModel,
  listedModel,
  parseModelRef,
  preferDefaultModel,
  toolsSupportFromListing,
} from "./proxy/models.js";
import {
  isRetryableStatus,
  routeChat,
  sanitizeChatPayload,
  type ChatRequest,
  type RouteAttempt,
} from "./proxy/router.js";

test("provider catalog ids are unique and non-empty", () => {
  const ids = catalogIds();
  assert.equal(ids.length, new Set(ids).size);
  assert.ok(ids.length >= 40);
  for (const provider of PROVIDER_CATALOG) {
    assert.ok(provider.name);
    if (!provider.local) assert.ok(provider.env || provider.unsupported);
  }
});

test("local providers expose a base URL extra field", () => {
  for (const id of [
    "ollama",
    "sglang",
    "tailscale_ollama",
    "tailscale_sglang",
    "lmstudio",
    "llamacpp",
  ]) {
    const provider = providerById(id);
    assert.ok(provider, id);
    assert.equal(provider.local, true);
    const extra = providerExtraFields(provider);
    const base = extra.find((field) => field.key === "baseUrl");
    assert.ok(base, id + " missing baseUrl extra");
  }
});

test("self-hosted providers are not ready until Connect saves them", () => {
  const settings = emptySettings();
  assert.equal(isProviderReady(settings, "ollama"), false);
  assert.equal(isProviderReady(settings, "sglang"), false);
  assert.equal(isProviderReady(settings, "tailscale_sglang"), false);
  const connected = connectProvider(
    settings,
    "tailscale_sglang",
    { baseUrl: "http://valkyrie:30000/v1" },
    ["deepseek-v4-flash"]
  );
  assert.equal(isProviderReady(connected, "tailscale_sglang"), true);
  assert.equal(connected.model, "tailscale_sglang/deepseek-v4-flash");
  assert.deepEqual(connected.discovered.tailscale_sglang, ["deepseek-v4-flash"]);
});

test("removeProvider drops keys, URLs, discovered models, and routing", () => {
  let settings = setProviderKey(emptySettings(), "groq", "gsk_test");
  settings = setProviderKey(settings, "open_router", "or_test");
  settings.model = "groq/llama-3.3-70b-versatile";
  settings.fallbacks = ["open_router/openrouter/free", "groq/llama-3.1-8b-instant"];
  settings = connectProvider(
    settings,
    "tailscale_sglang",
    { baseUrl: "http://valkyrie:30000/v1" },
    ["deepseek-v4-flash"]
  );
  assert.equal(isProviderReady(settings, "groq"), true);
  assert.equal(isProviderConfigured(settings, "groq"), true);

  const withoutGroq = removeProvider(settings, "groq");
  assert.equal(isProviderReady(withoutGroq, "groq"), false);
  assert.equal(isProviderConfigured(withoutGroq, "groq"), false);
  assert.equal(withoutGroq.keys.groq, undefined);
  assert.equal(withoutGroq.enabled.groq, false);
  assert.equal(withoutGroq.model, "open_router/openrouter/free");
  assert.deepEqual(withoutGroq.fallbacks, ["open_router/openrouter/free"]);
  assert.equal(isProviderReady(withoutGroq, "open_router"), true);
  assert.equal(isProviderReady(withoutGroq, "tailscale_sglang"), true);

  const withoutSglang = removeProvider(withoutGroq, "tailscale_sglang");
  assert.equal(isProviderReady(withoutSglang, "tailscale_sglang"), false);
  assert.equal(withoutSglang.extra.tailscale_sglang, undefined);
  assert.equal(withoutSglang.discovered.tailscale_sglang, undefined);
  assert.equal(withoutSglang.enabled.tailscale_sglang, false);
});

test("removed local providers stay disconnected even if inventory still hints a URL", () => {
  const connected = connectProvider(
    emptySettings(),
    "ollama",
    { baseUrl: "http://127.0.0.1:11434/v1" },
    ["qwen2.5-coder:14b"]
  );
  const removed = removeProvider(connected, "ollama");
  const hinted = {
    ...removed,
    extra: { ...removed.extra, ollama: { baseUrl: "http://127.0.0.1:11434/v1" } },
  };
  assert.equal(isProviderReady(hinted, "ollama"), false);
});

test("removeProvider drops Autofind hosts and hosted models, and Apply cannot restore them", () => {
  let settings = connectProvider(
    emptySettings(),
    "ollama",
    { baseUrl: "http://127.0.0.1:11434/v1" },
    ["qwen2.5-coder:14b"]
  );
  settings = connectProvider(settings, "lmstudio", { baseUrl: "http://127.0.0.1:1234/v1" }, [
    "local-model",
  ]);
  settings = {
    ...settings,
    foundHosts: [
      {
        id: "sglang-valkyrie",
        kind: "sglang",
        scope: "tailscale",
        host: "valkyrie",
        label: "valkyrie · sglang",
        baseUrl: "http://valkyrie:30000/v1",
        models: ["deepseek-v4-flash"],
      },
    ],
  };
  assert.ok(defaultListedModels(settings).some((row) => row.id === "ollama/qwen2.5-coder:14b"));
  assert.ok(defaultListedModels(settings).some((row) => row.id === "lmstudio/local-model"));
  assert.equal(isAdminListed(settings, "ollama"), true);

  settings = removeProvider(settings, "ollama");
  settings = removeProvider(settings, "lmstudio");
  settings = removeProvider(settings, "sglang-valkyrie");

  assert.equal(isProviderReady(settings, "ollama"), false);
  assert.equal(isProviderConfigured(settings, "ollama"), false);
  assert.equal(isAdminListed(settings, "ollama"), false);
  assert.equal(isAdminListed(settings, "lmstudio"), false);
  assert.equal(settings.foundHosts.length, 0);
  assert.equal(
    defaultListedModels(settings).some((row) => row.id.startsWith("ollama/")),
    false
  );
  assert.equal(
    defaultListedModels(settings).some((row) => row.id.startsWith("lmstudio/")),
    false
  );

  const applied = applyAdminSettingsPatch(settings, {
    extra: {
      ollama: { baseUrl: "http://127.0.0.1:11434/v1" },
      lmstudio: { baseUrl: "http://127.0.0.1:1234/v1" },
    },
  });
  assert.equal(isProviderReady(applied, "ollama"), false);
  assert.equal(isProviderReady(applied, "lmstudio"), false);
  assert.equal(applied.enabled.ollama, false);
  assert.equal(applied.extra.ollama, undefined);
  assert.equal(isAdminListed(applied, "ollama"), false);
  assert.equal(
    defaultListedModels(applied).some((row) => row.id.startsWith("ollama/")),
    false
  );

  const previous = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
  try {
    const envApplied = applyEnvOverrides(applied);
    assert.equal(envApplied.extra.ollama, undefined);
    assert.equal(isProviderReady(envApplied, "ollama"), false);
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previous;
  }
});

test("connect does not overwrite an existing default model", () => {
  const settings = emptySettings();
  settings.model = "nvidia_nim/nvidia/nemotron-3-super-120b-a12b";
  const connected = connectProvider(settings, "ollama", { baseUrl: "http://127.0.0.1:11434/v1" }, [
    "qwen2.5-coder:14b",
  ]);
  assert.equal(connected.model, "nvidia_nim/nvidia/nemotron-3-super-120b-a12b");
});

test("free model ids include Zen -free, OpenRouter :free, and big-pickle", () => {
  assert.equal(isFreeModelId("big-pickle"), true);
  assert.equal(isFreeModelId("mimo-v2.5-free"), true);
  assert.equal(isFreeModelId("qwen/qwen3-coder:free"), true);
  assert.equal(isFreeModelId("llama-3.3-70b-versatile"), false);
  const ordered = preferDefaultModel(
    [
      listedModel("groq", "llama-3.3-70b-versatile", "Groq / llama"),
      listedModel("opencode_zen", "big-pickle", "Zen / pickle"),
      listedModel("nvidia_nim", "nvidia/nemotron-3-super-120b-a12b", "NIM / nemotron"),
    ],
    "nvidia_nim/nvidia/nemotron-3-super-120b-a12b"
  );
  assert.equal(ordered[0].id, "nvidia_nim/nvidia/nemotron-3-super-120b-a12b");
  assert.equal(ordered[1].id, "opencode_zen/big-pickle");
  assert.equal(ordered[1].free, true);
});

test("tool filter drops embeddings and models that omit tools in metadata", () => {
  assert.equal(isNonToolModelId("nomic-embed-text"), true);
  assert.equal(isNonToolModelId("nvidia/nv-embedqa-e5-v5"), true);
  assert.equal(isNonToolModelId("whisper-large-v3"), true);
  assert.equal(isNonToolModelId("llama-3.3-70b-versatile"), false);
  assert.equal(
    toolsSupportFromListing({ supported_parameters: ["temperature", "tools", "tool_choice"] }),
    true
  );
  assert.equal(toolsSupportFromListing({ supported_parameters: ["temperature", "top_p"] }), false);
  assert.equal(toolsSupportFromListing({ id: "llama-3.3-70b-versatile" }), null);
  assert.equal(
    keepToolCapableModel({ id: "openrouter/andromeda-alpha", supportsTools: false }),
    false
  );
  assert.equal(keepToolCapableModel({ id: "qwen/qwen3-coder:free", supportsTools: true }), true);
  assert.equal(keepToolCapableModel({ id: "llama-3.3-70b-versatile", supportsTools: null }), true);
});

test("OpenRouter-style /models listings keep only tool-capable ids", async () => {
  const settings = setProviderKey(emptySettings(), "open_router", "or_test");
  const provider = providerById("open_router");
  assert.ok(provider);
  const models = await discoverProviderModels(settings, provider, async (input) => {
    const url = String(input);
    assert.match(url, /supported_parameters=tools/);
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "qwen/qwen3-coder:free",
            supported_parameters: ["tools", "tool_choice", "temperature"],
          },
          { id: "google/gemma-3-4b-it:free", supported_parameters: ["temperature", "top_p"] },
          { id: "openai/text-embedding-3-small", supported_parameters: ["tools"] },
        ],
      }),
      { status: 200 }
    );
  });
  assert.deepEqual(models, ["qwen/qwen3-coder:free"]);
});

test("Ollama /api/show capabilities.tools drops models without tools", async () => {
  const settings = connectProvider(
    emptySettings(),
    "ollama",
    { baseUrl: "http://127.0.0.1:11434/v1" },
    []
  );
  const provider = providerById("ollama");
  assert.ok(provider);
  const models = await discoverProviderModels(settings, provider, async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/models")) return new Response("no", { status: 404 });
    if (url.endsWith("/api/tags")) {
      return new Response(
        JSON.stringify({
          models: [
            { name: "qwen2.5-coder:14b" },
            { name: "nomic-embed-text" },
            { name: "llama3.2" },
          ],
        }),
        { status: 200 }
      );
    }
    if (url.endsWith("/api/show")) {
      const name = JSON.parse(String(init?.body ?? "{}")).name as string;
      const tools = name !== "llama3.2";
      return new Response(
        JSON.stringify({
          template: tools ? "{{ if .Tools }}tools{{ end }}" : "plain {{ .Prompt }}",
          capabilities: tools ? ["completion", "tools"] : ["completion"],
        }),
        { status: 200 }
      );
    }
    return new Response("no", { status: 404 });
  });
  assert.deepEqual(models, ["qwen2.5-coder:14b"]);
});

test("Ollama discovery falls back to /api/tags when /v1/models fails", async () => {
  const settings = connectProvider(
    emptySettings(),
    "ollama",
    { baseUrl: "http://127.0.0.1:11434/v1" },
    []
  );
  const provider = providerById("ollama");
  assert.ok(provider);
  const hits: string[] = [];
  const models = await discoverProviderModels(settings, provider, async (input) => {
    const url = String(input);
    hits.push(url);
    if (url.includes("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:14b" }] }), {
        status: 200,
      });
    }
    return new Response("no openai surface", { status: 404 });
  });
  assert.deepEqual(models, ["qwen2.5-coder:14b"]);
  assert.ok(hits.some((url) => url.endsWith("/v1/models")));
  assert.ok(hits.some((url) => url.endsWith("/api/tags")));
});

test("OpenCode picker is restricted to the free-opencode provider", () => {
  const config = {
    enabled_providers: ["anthropic", "opencode"],
    disabled_providers: ["gemini"],
  };
  restrictToFreeOpenCodeProvider(config);
  assert.deepEqual(config.enabled_providers, [PROVIDER_ID]);
  assert.deepEqual(config.disabled_providers, ["gemini", "opencode"]);
});

test("parseModelRef splits provider/model including nested ids", () => {
  const ref = parseModelRef("nvidia_nim/nvidia/nemotron-3-super-120b-a12b");
  assert.equal(ref.providerId, "nvidia_nim");
  assert.equal(ref.model, "nvidia/nemotron-3-super-120b-a12b");
  assert.equal(ref.slug, "nvidia_nim/nvidia/nemotron-3-super-120b-a12b");
});

test("settings round-trip keeps keys and fallbacks", () => {
  const home = mkdtempSync(join(tmpdir(), "foc-"));
  let settings = emptySettings();
  settings = setProviderKey(settings, "groq", "gsk_test", {});
  settings.fallbacks = ["open_router/openrouter/free"];
  saveSettings(settings, home);
  const raw = JSON.parse(readFileSync(join(home, ".free-opencode", "config.json"), "utf8")) as {
    keys: { groq: string };
  };
  assert.equal(raw.keys.groq, "gsk_test");
  const loaded = normalizeSettings(raw);
  assert.equal(loaded.keys.groq, "gsk_test");
  assert.deepEqual(loaded.fallbacks, ["open_router/openrouter/free"]);
});

test("router falls through retryable failures to the next model", async () => {
  const settings = setProviderKey(emptySettings(), "groq", "k1");
  const withOpenRouter = setProviderKey(settings, "open_router", "k2");
  withOpenRouter.model = "groq/llama-3.3-70b-versatile";
  withOpenRouter.fallbacks = ["open_router/openrouter/free"];

  const hits: string[] = [];
  const result = await routeChat(
    withOpenRouter,
    { model: "groq/llama-3.3-70b-versatile", stream: false } satisfies ChatRequest,
    async (attempt: RouteAttempt) => {
      hits.push(attempt.ref.slug);
      if (attempt.ref.providerId === "groq") {
        return new Response(JSON.stringify({ error: { message: "nope" } }), { status: 429 });
      }
      return new Response(JSON.stringify({ id: "ok", choices: [] }), { status: 200 });
    }
  );
  assert.deepEqual(hits, ["groq/llama-3.3-70b-versatile", "open_router/openrouter/free"]);
  assert.equal(result.used.providerId, "open_router");
});

test("sanitizeChatPayload drops client-only fields and disables NIM thinking by default", () => {
  const payload = sanitizeChatPayload(
    {
      model: "free-opencode/nvidia_nim/nvidia/nemotron-3-super-120b-a12b",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      max_output_tokens: 128,
      providerOptions: { foo: 1 },
    },
    "nvidia/nemotron-3-super-120b-a12b",
    "nvidia_nim"
  );
  assert.equal(payload.model, "nvidia/nemotron-3-super-120b-a12b");
  assert.equal(payload.max_tokens, 128);
  assert.equal(payload.providerOptions, undefined);
  assert.deepEqual(payload.chat_template_kwargs, { enable_thinking: false });
});

test("sanitizeChatPayload fills empty OpenCode tool schemas and drops strict", () => {
  const payload = sanitizeChatPayload(
    {
      model: "sglang/deepseek-v4-flash",
      messages: [],
      tools: [
        {
          type: "function",
          function: { name: "glob", parameters: { type: "object" }, strict: true },
        },
      ],
    },
    "deepseek-v4-flash",
    "sglang"
  );
  const tools = payload.tools as Array<{
    type: string;
    function: { name: string; parameters: { required?: string[] }; strict?: boolean };
  }>;
  assert.equal(tools[0].type, "function");
  assert.equal(tools[0].function.name, "glob");
  assert.deepEqual(tools[0].function.parameters.required, ["pattern"]);
  assert.equal(tools[0].function.strict, undefined);
});

test("429 and 5xx are retryable, 401 is not", () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(401), false);
});
