import { foundHostProviders, inventoryProviders } from "./inventory.js";

export type ExtraField = {
  key: string;
  env?: string;
  label: string;
  placeholder?: string;
  required?: boolean;
};

export type ProviderFamily = "ollama" | "openai";

export type ProviderDescriptor = {
  id: string;
  name: string;
  env?: string;
  credentialUrl?: string;
  defaultBaseUrl?: string;
  baseUrlEnv?: string;
  local?: boolean;
  /** How to list models. Ollama family also tries /api/tags. */
  family?: ProviderFamily;
  staticKey?: string;
  extra?: ExtraField[];
  defaultModels: string[];
  notes?: string;
  /** Skip /connect and admin key fields — needs a specialized adapter. */
  unsupported?: string;
  /** Extra query string on GET /models (no leading ?). */
  modelsQuery?: string;
};

export const PROVIDER_CATALOG: ProviderDescriptor[] = [
  {
    id: "nvidia_nim",
    name: "NVIDIA NIM",
    env: "NVIDIA_NIM_API_KEY",
    credentialUrl: "https://build.nvidia.com/settings/api-keys",
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
    defaultModels: [
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k2-instruct",
      "qwen/qwen3-coder-480b-a35b-instruct",
    ],
  },
  {
    id: "open_router",
    name: "OpenRouter",
    env: "OPENROUTER_API_KEY",
    credentialUrl: "https://openrouter.ai/keys",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModels: ["openrouter/free", "qwen/qwen3-coder:free", "moonshotai/kimi-k2:free"],
    modelsQuery: "supported_parameters=tools",
  },
  {
    id: "groq",
    name: "Groq",
    env: "GROQ_API_KEY",
    credentialUrl: "https://console.groq.com/keys",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    defaultModels: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "qwen/qwen3-32b"],
  },
  {
    id: "cline_pass",
    name: "ClinePass",
    env: "CLINE_API_KEY",
    credentialUrl: "https://docs.cline.bot/getting-started/clinepass",
    defaultBaseUrl: "https://api.cline.bot/api/v1",
    defaultModels: ["cline-pass/kimi-k3"],
  },
  {
    id: "xai",
    name: "xAI",
    env: "XAI_API_KEY",
    credentialUrl: "https://console.x.ai/team/default/api-keys",
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModels: ["grok-4.5", "grok-code-fast-1"],
  },
  {
    id: "qwencloud",
    name: "QwenCloud Token Plan",
    env: "QWENCLOUD_API_KEY",
    credentialUrl: "https://home.qwencloud.com/api-keys",
    defaultBaseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    defaultModels: ["qwen3.7-plus", "qwen3-coder-plus"],
  },
  {
    id: "qwencloud_coding",
    name: "QwenCloud Coding Plan",
    env: "QWENCLOUD_CODING_API_KEY",
    credentialUrl: "https://home.qwencloud.com/api-keys",
    defaultBaseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
    defaultModels: ["qwen3.7-plus", "qwen3-coder-plus"],
  },
  {
    id: "together",
    name: "Together AI",
    env: "TOGETHER_API_KEY",
    credentialUrl: "https://api.together.ai/settings/api-keys",
    defaultBaseUrl: "https://api.together.ai/v1",
    defaultModels: ["zai-org/GLM-5.2", "Qwen/Qwen3-Coder-480B-A35B-Instruct"],
  },
  {
    id: "deepinfra",
    name: "DeepInfra",
    env: "DEEPINFRA_API_KEY",
    credentialUrl: "https://deepinfra.com/dash/api_keys",
    defaultBaseUrl: "https://api.deepinfra.com/v1/openai",
    defaultModels: ["deepseek-ai/DeepSeek-V4-Flash", "Qwen/Qwen3-32B"],
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    env: "SILICONFLOW_API_KEY",
    credentialUrl: "https://cloud.siliconflow.com/account/ak",
    defaultBaseUrl: "https://api.siliconflow.com/v1",
    defaultModels: ["Qwen/Qwen3-32B", "deepseek-ai/DeepSeek-V3"],
  },
  {
    id: "nebius",
    name: "Nebius Token Factory",
    env: "NEBIUS_API_KEY",
    credentialUrl: "https://tokenfactory.nebius.com/project/api-keys",
    defaultBaseUrl: "https://api.tokenfactory.nebius.com/v1",
    defaultModels: ["Qwen/Qwen3-30B-A3B"],
  },
  {
    id: "chutes",
    name: "Chutes",
    env: "CHUTES_API_KEY",
    credentialUrl: "https://chutes.ai/docs/getting-started/authentication",
    defaultBaseUrl: "https://llm.chutes.ai/v1",
    defaultModels: ["Qwen/Qwen3-32B-TEE"],
  },
  {
    id: "featherless",
    name: "Featherless AI",
    env: "FEATHERLESS_API_KEY",
    credentialUrl: "https://featherless.ai/account/api-keys",
    defaultBaseUrl: "https://api.featherless.ai/v1",
    defaultModels: ["Qwen/Qwen3-32B"],
  },
  {
    id: "agnes",
    name: "Agnes AI",
    env: "AGNES_API_KEY",
    credentialUrl: "https://agnes-ai.com/",
    defaultBaseUrl: "https://apihub.agnes-ai.com/v1",
    defaultModels: ["agnes-2.0-flash"],
  },
  {
    id: "zenmux",
    name: "ZenMux",
    env: "ZENMUX_API_KEY",
    credentialUrl: "https://zenmux.ai/platform/pay-as-you-go",
    defaultBaseUrl: "https://zenmux.ai/api/v1",
    defaultModels: ["deepseek/deepseek-v4-flash-free"],
  },
  {
    id: "wandb",
    name: "W&B Inference",
    env: "WANDB_API_KEY",
    credentialUrl: "https://wandb.ai/settings",
    defaultBaseUrl: "https://api.inference.wandb.ai/v1",
    defaultModels: ["openai/gpt-oss-20b"],
  },
  {
    id: "azure_openai",
    name: "Azure OpenAI",
    env: "AZURE_OPENAI_API_KEY",
    credentialUrl: "https://ai.azure.com/",
    extra: [
      {
        key: "baseUrl",
        env: "AZURE_OPENAI_BASE_URL",
        label: "Azure v1 endpoint",
        placeholder: "https://YOUR-RESOURCE.openai.azure.com/openai/v1/",
        required: true,
      },
    ],
    defaultModels: [],
  },
  {
    id: "gemini",
    name: "Google AI Studio (Gemini)",
    env: "GEMINI_API_KEY",
    credentialUrl: "https://aistudio.google.com/apikey",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    defaultModels: ["models/gemini-3.1-flash-lite", "models/gemini-2.5-flash"],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    env: "DEEPSEEK_API_KEY",
    credentialUrl: "https://platform.deepseek.com/api_keys",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModels: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "mistral",
    name: "Mistral La Plateforme",
    env: "MISTRAL_API_KEY",
    credentialUrl: "https://console.mistral.ai/",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    defaultModels: ["devstral-small-latest", "mistral-large-latest"],
  },
  {
    id: "mistral_codestral",
    name: "Mistral Codestral",
    env: "CODESTRAL_API_KEY",
    credentialUrl: "https://console.mistral.ai/",
    defaultBaseUrl: "https://codestral.mistral.ai/v1",
    defaultModels: ["codestral-latest"],
  },
  {
    id: "opencode_zen",
    name: "OpenCode Zen",
    env: "OPENCODE_API_KEY",
    credentialUrl: "https://opencode.ai/auth",
    defaultBaseUrl: "https://opencode.ai/zen/v1",
    defaultModels: [
      "big-pickle",
      "mimo-v2.5-free",
      "nemotron-3-ultra-free",
      "nemotron-3.5-lightning-free",
      "ling-3.0-flash-fin-free",
      "muse-spark-1.2-contributor-free",
      "deepseek-v4-flash-free",
      "laguna-s-2.1-free",
    ],
    notes:
      "OpenCode's own pool. Free tool models (*-free, big-pickle) are listed first. Needs a Zen key; those ids are $0.",
  },
  {
    id: "opencode_go",
    name: "OpenCode Go",
    env: "OPENCODE_API_KEY",
    credentialUrl: "https://opencode.ai/auth",
    defaultBaseUrl: "https://opencode.ai/zen/go/v1",
    defaultModels: ["minimax-m2.7"],
  },
  {
    id: "vercel",
    name: "Vercel AI Gateway",
    env: "AI_GATEWAY_API_KEY",
    credentialUrl: "https://vercel.com/docs/ai-gateway/models-and-providers",
    defaultBaseUrl: "https://ai-gateway.vercel.sh/v1",
    defaultModels: ["openai/gpt-5.5"],
  },
  {
    id: "bedrock",
    name: "Amazon Bedrock",
    env: "AWS_BEARER_TOKEN_BEDROCK",
    credentialUrl: "https://console.aws.amazon.com/bedrock/",
    defaultBaseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
    extra: [
      {
        key: "baseUrl",
        env: "BEDROCK_BASE_URL",
        label: "Bedrock OpenAI-compatible base URL",
        placeholder: "https://bedrock-mantle.us-east-1.api.aws/v1",
      },
    ],
    defaultModels: ["openai.gpt-oss-120b"],
  },
  {
    id: "huggingface",
    name: "Hugging Face Inference",
    env: "HUGGINGFACE_API_KEY",
    credentialUrl: "https://huggingface.co/settings/tokens",
    defaultBaseUrl: "https://router.huggingface.co/v1",
    defaultModels: ["Qwen/Qwen3-Coder-480B-A35B-Instruct:fastest"],
  },
  {
    id: "cohere",
    name: "Cohere",
    env: "COHERE_API_KEY",
    credentialUrl: "https://dashboard.cohere.com/api-keys",
    defaultBaseUrl: "https://api.cohere.ai/compatibility/v1",
    defaultModels: ["command-a-plus-05-2026"],
  },
  {
    id: "github_models",
    name: "GitHub Models",
    env: "GITHUB_MODELS_TOKEN",
    credentialUrl: "https://github.com/marketplace?type=models",
    defaultBaseUrl: "https://models.github.ai/inference",
    defaultModels: ["openai/gpt-4.1"],
  },
  {
    id: "wafer",
    name: "Wafer",
    env: "WAFER_API_KEY",
    credentialUrl: "https://wafer.ai/",
    defaultBaseUrl: "https://pass.wafer.ai/v1",
    defaultModels: ["DeepSeek-V4-Pro"],
  },
  {
    id: "kimi",
    name: "Kimi API",
    env: "KIMI_API_KEY",
    credentialUrl: "https://platform.moonshot.ai/console/api-keys",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    defaultModels: ["kimi-k2.5"],
  },
  {
    id: "kimi_code",
    name: "Kimi Code",
    env: "KIMI_CODE_API_KEY",
    credentialUrl: "https://www.kimi.com/code/console",
    defaultBaseUrl: "https://api.kimi.com/coding/v1",
    defaultModels: ["k3"],
  },
  {
    id: "minimax",
    name: "MiniMax",
    env: "MINIMAX_API_KEY",
    credentialUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    defaultBaseUrl: "https://api.minimax.io/v1",
    defaultModels: ["MiniMax-M3"],
  },
  {
    id: "cerebras",
    name: "Cerebras Inference",
    env: "CEREBRAS_API_KEY",
    credentialUrl: "https://cloud.cerebras.ai/",
    defaultBaseUrl: "https://api.cerebras.ai/v1",
    defaultModels: ["gpt-oss-120b"],
  },
  {
    id: "sambanova",
    name: "SambaNova",
    env: "SAMBANOVA_API_KEY",
    credentialUrl: "https://cloud.sambanova.ai/apis",
    defaultBaseUrl: "https://api.sambanova.ai/v1",
    defaultModels: ["Meta-Llama-3.3-70B-Instruct"],
  },
  {
    id: "kilo",
    name: "Kilo.ai",
    env: "KILO_API_KEY",
    credentialUrl: "https://kilo.ai",
    defaultBaseUrl: "https://api.kilo.ai/api/gateway",
    defaultModels: ["kilo-auto/free"],
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    env: "FIREWORKS_API_KEY",
    credentialUrl: "https://fireworks.ai/account/api-keys",
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModels: ["accounts/fireworks/models/llama-v3p3-70b-instruct"],
  },
  {
    id: "novita",
    name: "Novita AI",
    env: "NOVITA_API_KEY",
    credentialUrl: "https://novita.ai/settings/key-management",
    defaultBaseUrl: "https://api.novita.ai/openai/v1",
    defaultModels: ["deepseek/deepseek-v4-flash-0731"],
  },
  {
    id: "cloudflare",
    name: "Cloudflare Workers AI",
    env: "CLOUDFLARE_API_TOKEN",
    credentialUrl: "https://developers.cloudflare.com/workers-ai/",
    extra: [
      {
        key: "accountId",
        env: "CLOUDFLARE_ACCOUNT_ID",
        label: "Cloudflare account ID",
        required: true,
      },
    ],
    defaultModels: ["@cf/moonshotai/kimi-k2.6"],
  },
  {
    id: "zai",
    name: "Z.ai Coding Plan",
    env: "ZAI_API_KEY",
    credentialUrl: "https://z.ai/manage-apikey/apikey-list",
    defaultBaseUrl: "https://api.z.ai/api/coding/paas/v4",
    defaultModels: ["glm-5.2"],
  },
  {
    id: "zai_api",
    name: "Z.ai API",
    env: "ZAI_API_KEY",
    credentialUrl: "https://z.ai/manage-apikey/apikey-list",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    defaultModels: ["glm-4.7-flash"],
  },
  {
    id: "tokenrouter",
    name: "TokenRouter",
    env: "TOKENROUTER_API_KEY",
    credentialUrl: "https://www.tokenrouter.com/",
    defaultBaseUrl: "https://api.tokenrouter.com/v1",
    defaultModels: ["moonshotai/kimi-k3-free"],
  },
  {
    id: "nararoute",
    name: "NaraRoute",
    env: "NARAROUTE_API_KEY",
    credentialUrl: "https://router.bynara.id/",
    defaultBaseUrl: "https://router.bynara.id/v1",
    defaultModels: ["kimi-k3-free"],
  },
  {
    id: "poolside",
    name: "Poolside AI",
    env: "POOLSIDE_API_KEY",
    credentialUrl: "https://platform.poolside.ai/",
    defaultBaseUrl: "https://inference.poolside.ai/v1",
    defaultModels: ["poolside/laguna-s-2.1"],
  },
  {
    id: "llm7",
    name: "LLM7.io",
    env: "LLM7_API_KEY",
    credentialUrl: "https://dash.llm7.io/",
    defaultBaseUrl: "https://api.llm7.io/v1",
    defaultModels: ["default"],
  },
  {
    id: "ollama_cloud",
    name: "Ollama Cloud",
    env: "OLLAMA_API_KEY",
    credentialUrl: "https://ollama.com/settings/keys",
    defaultBaseUrl: "https://ollama.com/v1",
    defaultModels: ["qwen3-coder:480b"],
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    local: true,
    family: "openai",
    staticKey: "lm-studio",
    defaultBaseUrl: "http://127.0.0.1:1234/v1",
    baseUrlEnv: "LM_STUDIO_BASE_URL",
    extra: [
      {
        key: "baseUrl",
        env: "LM_STUDIO_BASE_URL",
        label: "Base URL",
        placeholder: "http://127.0.0.1:1234/v1",
      },
    ],
    defaultModels: [],
    notes: "Start LM Studio's local server, then Connect.",
  },
  {
    id: "llamacpp",
    name: "llama.cpp",
    local: true,
    family: "openai",
    staticKey: "llamacpp",
    defaultBaseUrl: "http://127.0.0.1:8080/v1",
    baseUrlEnv: "LLAMACPP_BASE_URL",
    extra: [
      {
        key: "baseUrl",
        env: "LLAMACPP_BASE_URL",
        label: "Base URL",
        placeholder: "http://127.0.0.1:8080/v1",
      },
    ],
    defaultModels: [],
    notes: "llama-server OpenAI-compatible endpoint.",
  },
  {
    id: "ollama",
    name: "Ollama",
    local: true,
    family: "ollama",
    staticKey: "ollama",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    baseUrlEnv: "OLLAMA_BASE_URL",
    extra: [
      {
        key: "baseUrl",
        env: "OLLAMA_BASE_URL",
        label: "Base URL",
        placeholder: "http://127.0.0.1:11434/v1",
      },
    ],
    defaultModels: [],
    notes: "Local ollama serve. Connect lists tags from /api/tags.",
  },
  {
    id: "sglang",
    name: "SGLang",
    local: true,
    family: "openai",
    staticKey: "sglang",
    defaultBaseUrl: "http://127.0.0.1:30000/v1",
    baseUrlEnv: "SGLANG_BASE_URL",
    extra: [
      {
        key: "baseUrl",
        env: "SGLANG_BASE_URL",
        label: "Base URL",
        placeholder: "http://127.0.0.1:30000/v1",
      },
    ],
    defaultModels: [],
    notes: "Local sglang (default :30000). OpenAI-compatible /v1.",
  },
  {
    id: "tailscale_ollama",
    name: "Tailscale Ollama",
    local: true,
    family: "ollama",
    staticKey: "ollama",
    baseUrlEnv: "TAILSCALE_OLLAMA_BASE_URL",
    extra: [
      {
        key: "baseUrl",
        env: "TAILSCALE_OLLAMA_BASE_URL",
        label: "Tailscale URL",
        placeholder: "http://gpu-box:11434/v1",
        required: true,
      },
    ],
    defaultModels: [],
    notes:
      "Ollama on a Tailscale machine. MagicDNS or 100.x:11434. The box must bind OLLAMA_HOST to the tailnet, not 127.0.0.1.",
  },
  {
    id: "tailscale_sglang",
    name: "Tailscale SGLang",
    local: true,
    family: "openai",
    staticKey: "sglang",
    baseUrlEnv: "TAILSCALE_SGLANG_BASE_URL",
    extra: [
      {
        key: "baseUrl",
        env: "TAILSCALE_SGLANG_BASE_URL",
        label: "Tailscale URL",
        placeholder: "http://gpu-box:30000/v1",
        required: true,
      },
    ],
    defaultModels: [],
    notes: "SGLang on a Tailscale machine. MagicDNS or 100.x:30000.",
  },
];

export function isOllamaFamily(provider: ProviderDescriptor): boolean {
  return provider.family === "ollama";
}

export function allProviders(): ProviderDescriptor[] {
  const inventory = inventoryProviders();
  const seen = new Set<string>();
  const out: ProviderDescriptor[] = [];
  const push = (provider: ProviderDescriptor): void => {
    if (seen.has(provider.id)) return;
    seen.add(provider.id);
    out.push(provider);
  };
  for (const provider of inventory) push(provider);
  for (const provider of foundHostProviders()) push(provider);
  for (const provider of PROVIDER_CATALOG.filter((p) => p.local)) push(provider);
  for (const provider of PROVIDER_CATALOG.filter((p) => !p.local)) push(provider);
  return out;
}

export function providerById(id: string): ProviderDescriptor | undefined {
  return allProviders().find((provider) => provider.id === id);
}

export function catalogIds(): string[] {
  return allProviders().map((p) => p.id);
}

export function providerExtraFields(provider: ProviderDescriptor): ExtraField[] {
  const extra = [...(provider.extra ?? [])];
  if (provider.local && !extra.some((field) => field.key === "baseUrl")) {
    extra.unshift({
      key: "baseUrl",
      env: provider.baseUrlEnv,
      label: "Base URL",
      placeholder: provider.defaultBaseUrl,
    });
  }
  return extra;
}
