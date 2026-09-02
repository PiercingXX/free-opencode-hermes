# Free OpenCode & Hermes

Use [OpenCode](https://opencode.ai) and Hermes against a local multi-provider proxy.

The catalog is one loopback gateway, many upstreams, fallbacks, and Admin for keys. `foc-opencode` is a **launcher**, not an agent rewrite. OpenCode keeps its built-in tools (Glob, Read, Bash). Nested [xx-stack](https://github.com/piercingxx/xx-stack) stays the GPU/Hermes plane (`xx-hermes` on `:8180`).

Independent open-source project by [PiercingXX](https://github.com/PiercingXX). Not affiliated with OpenCode or Nous Research.

---

## How it works

There are two local gateways. They do different jobs.

```
You
 ├─ foc-opencode ──► temp opencode.json + OPENCODE_CONFIG_CONTENT overlay
 │                      ├─ provider "free-opencode" via @ai-sdk/openai
 │                      ├─ talks Responses: POST /v1/responses
 │                      ├─ OpenCode native tools (Glob, Read, Bash)
 │                      └─ child env FOC_OPENCODE_API_KEY (never persisted)
 │
 ├─ foc-hermes ────► chmod-700 managed dir + private config.yaml
 │                      ├─ nonce provider custom:foc-<nonce>
 │                      ├─ transport / api_mode: codex_responses
 │                      └─ child env FOC_HERMES_<NONCE>
 │
 │               Both hit the same catalog:
 │                 http://127.0.0.1:8082/v1
 │
 │               Free OpenCode proxy
 │                 ├─ NVIDIA NIM, OpenRouter, Groq, xAI, …
 │                 ├─ local Ollama / LM Studio / llama.cpp
 │                 └─ fallbacks: try next model on 429 / 5xx
 │
 ├─ opencode ──────► plugin fallback (same provider, forces a FOC model)
 │
 └─ xx-hermes ─────► Hermes orchestration proxy (separate plane)
                      http://127.0.0.1:8180/v1
                      sglang → ollama on your machines
                      cloud only if you opt in
```

**Catalog path (port 8082).** This is the loopback catalog client path. `foc-opencode` and `foc-hermes` do **not** rewrite `~/.config/opencode/opencode.json` or `~/.hermes/config.yaml`. They write a process-local config, overlay-force the default model from Admin, and point the child at `http://127.0.0.1:8082/v1`. OpenCode uses the OpenAI Responses wire (`@ai-sdk/openai`, `/v1/responses`). Hermes uses `codex_responses` against the same endpoint. The proxy translates Responses (tools, reasoning, text) into upstream Chat Completions, then translates the stream back.

**`opencode` is the normal launch.** The plugin writes `free-opencode/default` into config, starts `:8082` if needed, and injects xx-stack agents. `foc-opencode` is optional: it adds a process-local `OPENCODE_CONFIG_CONTENT` overlay so a saved Zen model (`opencode/x-preview-f-free`) cannot steal the session.

**Do not inject xx-stack into OpenCode.** Markdown agents under `~/.config/opencode/agents/` (especially `build.md`) replace OpenCode's native `build` agent. Weak models then emit empty `$` / `Read` / `Glob ""` calls, OpenCode aborts them, and the session loops. `foc-opencode` hides those vendor primaries and leaves Glob/Read/Bash alone. GPU routing stays on `xx-hermes` (`:8180`), not inside the OpenCode TUI.

**GPU/Ollama path (port 8180).** Separate control plane. `inventory.json` describes the machines you own. `npm run inventory:sync` writes lanes into `hermes-orchestration/config/orchestration.json`. `xx-hermes` points Hermes Agent at that loopback proxy. Use `foc-hermes` for the loopback catalog; use `xx-hermes` for your own boxes.

Keys never go into OpenCode or Hermes config files. They live in `~/.free-opencode/config.json` (or env vars). The wrappers inject a loopback token only into the child process.

---

## What you need

|                 | OpenCode setup         | Hermes setup                              |
| --------------- | ---------------------- | ----------------------------------------- |
| Node.js 20+     | required               | required                                  |
| npm             | required               | required                                  |
| OpenCode CLI    | installer can fetch it | not required                              |
| Python 3        | not required           | required (`python3` or `python`)          |
| Hermes Agent    | not required           | installer can fetch it                    |
| GPU / Tailscale | optional               | optional; local Ollama is enough to start |

Linux, macOS, and native Windows are supported. Git Bash can run the `.sh` installers on Windows; PowerShell is the native Windows path.

---

## Setup: OpenCode

This is the main product path.

### 1. Clone

```bash
git clone https://github.com/PiercingXX/free-opencode-hermes
cd free-opencode-hermes
```

### 2. Run the installer

Linux / macOS:

```bash
./install-opencode.sh
```

Windows PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install-opencode.ps1
```

Already have the OpenCode CLI? Skip downloading it:

```bash
./install-opencode.sh --skip-opencode
```

```powershell
.\install-opencode.ps1 -SkipOpenCode
```

The installer will:

1. Require Node 20+
2. Create `inventory.json` from `inventory.example.json` if you do not have one
3. `npm ci` / `npm install`, then build `xx-stack/mcp-server` and `packages/plugin`
4. `npm run inventory:sync` — generate platform registries and Hermes lanes
5. Linux: run `opencode-orchestration/setup.sh` (agents, skills, live MCP registration)
6. Install the OpenCode CLI if it is missing
7. Register the plugin in `~/.config/opencode/opencode.json` as a `file://` URL
8. Copy skills, xx-stack subagents, and slash commands (`/review`, `/plan`, `/debug`, `/ship`, `/explore`, `/route`, `/judge`) into `~/.config/opencode/` (not `build.md` / `plan.md` / `general.md` — those names replace OpenCode's native tools)
9. Put `free-opencode`, `foc-opencode`, and `foc-hermes` on `~/.local/bin` (`.cmd` on Windows)
10. Start the proxy on `127.0.0.1:8082`

On Windows, open a **new** terminal after install so `~/.local/bin` is on PATH.

### 3. Admin: keys, boxes, free models

Loopback only: [http://127.0.0.1:8082/admin](http://127.0.0.1:8082/admin)

Cloud providers sit at the top. Paste a key, **Check**, **Apply**. Configured cards turn **blue**. **Remove** drops the key, URL, discovered models, and any fallback that pointed at that provider. Cloud cards stay on the page so you can paste a key later.

Self-hosted is at the bottom. **Autofind** probes localhost (Ollama `:11434`, SGLang `:30000`, LM Studio `:1234`, llama.cpp `:8080`, vLLM `:8000`), LAN neighbors from ARP, and Tailscale peers, then Connects whatever answers. Tool-capable models only. Extra boxes show up as `sglang-valkyrie`-style cards. **Remove** takes a box off the list and drops the models it was hosting. **Apply** does not reconnect it from a leftover default URL — Autofind or Connect puts it back. Remote Ollama must bind the tailnet (`OLLAMA_HOST=0.0.0.0` or the `100.x` address), not only `127.0.0.1`.

Same jobs from the CLI:

```bash
free-opencode connect                  # list providers
free-opencode connect nvidia_nim       # cloud key
free-opencode autofind                 # localhost + LAN + Tailscale
free-opencode connect tailscale_sglang # one box, by hand
free-opencode remove nvidia_nim
free-opencode models --free
```

`disconnect` is an alias for `remove`.

**What gets into the catalog.** Only models that can take tools. OpenRouter is queried with `supported_parameters=tools`. Embeddings, Whisper, TTS, and rerankers are dropped. Ollama uses `/api/show` (`capabilities: tools` or a `.Tools` template). If a provider does not say, chat ids stay.

**Free tool models.** Admin lists them with a **Use** button (sets the default). That list is:

- OpenCode Zen `*-free` and `big-pickle` (needs `OPENCODE_API_KEY`; tokens are $0 on those ids)
- OpenRouter `:free` that already passed the tools filter
- Anything on your own boxes

Keys can also come from the environment (see [Providers](#providers)):

```bash
export NVIDIA_NIM_API_KEY=nvapi-...
export GROQ_API_KEY=gsk_...
export OPENCODE_API_KEY=...            # Zen / Go
export OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
export SGLANG_BASE_URL=http://127.0.0.1:30000/v1
export TAILSCALE_SGLANG_BASE_URL=http://valkyrie:30000/v1
export TAILSCALE_OLLAMA_BASE_URL=http://gpu-box:11434/v1
export LM_STUDIO_BASE_URL=http://127.0.0.1:1234/v1
export LLAMACPP_BASE_URL=http://127.0.0.1:8080/v1
```

Enabled Tailscale Ollama / SGLang runtimes in `inventory.json` also show up as their own cards (`sglang-<machine-id>`, `ollama-<machine-id>`).

### 4. Set the default model and fallbacks

OpenCode's picker is one entry: **Free OpenCode** / `default`. The real upstream is whatever Admin has as default, then fallbacks. `foc-opencode` is a process-local provider overlay. It does not replace OpenCode's built-in `build` agent with xx-stack prompts.

In Admin, **Use** on a free row, or:

```bash
free-opencode set-model opencode_zen/big-pickle
free-opencode set-fallback ollama/qwen2.5-coder:14b open_router/qwen/qwen3-coder:free
free-opencode models --free
free-opencode status
```

`status` should show `health: ok` and the providers you configured under `ready`. Model ids are `provider_id/upstream-model-id`.

### 5. Run OpenCode

Needs OpenCode **1.18.18+**. Always start a **new** session with the launcher:

```bash
opencode
# optional overlay if a saved Zen model steals the session:
foc-opencode
# same thing:
free-opencode opencode
```

`foc-opencode` starts the proxy if it is down, snapshots `/v1/models?view=responses`, and launches OpenCode with a temp config. Pass-through (no live proxy): `foc-opencode --version`, `foc-opencode auth`, `foc-opencode upgrade`.

In the TUI:

- `/models` — one entry, **Free OpenCode** / `default`. Pick the real upstream in Admin.
- Native tools: **Glob** (`pattern` required), **Read** (`filePath` required), **Grep** (`pattern` required), **Bash** (`command` required), Edit.

Do not reuse a session that already looped on empty `$` / `Read` / `Glob ""`. Quit and run `opencode` again.

`opencode` is the normal launch: the plugin injects the catalog, starts the
proxy if needed, and loads xx-stack agents. `foc-opencode` is optional and
adds a process-local overlay so a saved Zen model cannot steal the session.

```bash
free-opencode start
free-opencode stop
```

---

## Setup: Hermes

Two launchers, two jobs.

**Catalog (`foc-hermes`).** Hermes Agent **0.20.4+**, attached terminal sessions only, against the same `:8082` catalog as OpenCode. Needs the OpenCode installer (or a built plugin CLI) so `foc-hermes` is on PATH.

```bash
foc-hermes
# same thing:
free-opencode hermes
foc-hermes --model groq/llama-3.3-70b-versatile
```

The wrapper writes a chmod-700 managed dir, a private `config.yaml`, and a nonce provider `custom:foc-<nonce>` with `codex_responses`. It refuses detached surfaces (`gateway`, `serve`, `cron`, `mcp serve`, …) and will not replace an existing `HERMES_MANAGED_DIR`. Use ordinary `hermes` for those.

**GPU/Ollama (`xx-hermes`).** Same repo, second installer. Use this when you want Hermes Agent on your own GPUs / Ollama boxes, not the loopback catalog.

Linux / macOS:

```bash
./install-hermes.sh
```

Skip systemd (proxy starts when you run `xx-hermes`):

```bash
./install-hermes.sh --no-systemd
```

Windows PowerShell:

```powershell
.\install-hermes.ps1
```

The installer will:

1. Require Node 20+ and Python 3
2. Seed inventory, install npm deps, build, `inventory:sync`
3. Install Hermes Agent if missing
4. Write `~/.config/hermes-orchestration/proxy.env` (`HERMES_PROXY_TOKEN`)
5. Put `xx-hermes` on `~/.local/bin` (and `foc-hermes` if the plugin CLI is already built)
6. Linux + systemd: enable `hermes-proxy.service` on `127.0.0.1:8180`
7. Windows / no systemd: `xx-hermes` starts that proxy itself if it is down

Then point inventory at machines you actually own. The shipped `example-gpu-box` is a disabled template.

```bash
# edit inventory.json, then:
npm run inventory:sync
npm run inventory:list
npm run inventory:enable -- local-workstation.ollama
# or a real Tailscale host you added:
npm run inventory:enable -- gpu-box.sglang

python3 hermes-orchestration/scripts/hermes_orchestrator.py health
xx-hermes          # :8180 self-hosted lanes
foc-hermes         # :8082 loopback catalog (after install-opencode)
```

Cloud stays off until `policy.cloudEscalation.optIn` is `true` in `inventory.json`, or you export `XX_STACK_ALLOW_CLOUD=1`.

---

## Everyday commands

Same on Linux and Windows.

```bash
free-opencode status
free-opencode admin                 # prints http://127.0.0.1:8082/admin
free-opencode connect               # list providers
free-opencode connect groq
free-opencode autofind              # localhost + LAN ARP + Tailscale
free-opencode remove                # list saved providers
free-opencode remove groq
free-opencode models
free-opencode models --free
free-opencode set-model opencode_zen/big-pickle
free-opencode set-fallback ollama/qwen2.5-coder:14b open_router/qwen/qwen3-coder:free
free-opencode start
free-opencode start --foreground    # stay in this terminal
free-opencode stop
foc-opencode                        # OpenCode + :8082 catalog
foc-hermes                          # Hermes + :8082 catalog
xx-hermes                           # Hermes + :8180 GPU/Ollama plane
```

```bash
npm run inventory:scan              # Tailscale probe (optional)
npm run inventory:scan -- --write
npm run inventory:list
npm run inventory:enable -- <machine-or-lane>
npm run inventory:disable -- <machine-or-lane>
npm run inventory:sync
```

---

## Files on disk

| Path                                         | What                                                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `~/.free-opencode/config.json`               | Proxy settings, API keys, default model, fallbacks, Autofind hosts, local token                                             |
| `~/.free-opencode/proxy.pid`                 | Detached proxy pid                                                                                                          |
| `~/.config/opencode/opencode.json`           | OpenCode global config; installer appends the plugin `file://` URL. Same path on Windows: `%USERPROFILE%\.config\opencode\` |
| `~/.config/opencode/skills/`                 | Copied xx-stack skills                                                                                                      |
| `~/.config/opencode/agents/`                 | Copied xx-stack agent files                                                                                                 |
| `~/.config/opencode/xx-stack-platforms.json` | Live routing inventory for the MCP server                                                                                   |
| `~/.local/bin/free-opencode`                 | CLI wrapper (`free-opencode.cmd` on Windows)                                                                                |
| `~/.local/bin/foc-opencode`                  | Process-local OpenCode launcher (`foc-opencode.cmd` on Windows)                                                             |
| `~/.local/bin/foc-hermes`                    | Process-local Hermes catalog launcher                                                                                       |
| `~/.local/bin/xx-hermes`                     | Hermes :8180 GPU/Ollama launcher                                                                                            |
| `~/.config/hermes-orchestration/proxy.env`   | `HERMES_PROXY_TOKEN` for port 8180                                                                                          |
| `inventory.json`                             | **Your** machines. Gitignored. Start from `inventory.example.json`                                                          |

Do not commit `inventory.json` or `~/.free-opencode/config.json`. They hold hostnames and keys.

---

## Request routing (OpenCode proxy)

1. `foc-opencode` and `foc-hermes` send OpenAI Responses (`POST /v1/responses`) to `http://127.0.0.1:8082/v1` with a child-only bearer token. Bare `opencode` via the plugin uses the same provider (`@ai-sdk/openai`). Chat Completions (`POST /v1/chat/completions`) still works for other clients.
2. The model field is `provider_id/rest`. `nvidia_nim/nvidia/foo` → provider `nvidia_nim`, upstream model `nvidia/foo`.
3. The proxy builds the candidate list: the requested model, then `model` from config, then `fallbacks`, skipping duplicates and providers that are not ready.
4. Each candidate is tried in order. HTTP 408 / 409 / 429 / 5xx and network errors move to the next. 401 / 400 stop. Once a stream has started, that candidate is committed.
5. Admin is loopback-only. Inference binds `127.0.0.1` by default.

ChatGPT subscription OAuth and Google Vertex ADC are **not** in this proxy. Use a normal API-key provider or a local runtime.

---

## Providers

Configure in Admin, `free-opencode connect <id>`, or the env var. Model strings you pass to `set-model` are `<id>/<example>`.

| id                  | Name                  | Env                                              | Example model                                                 |
| ------------------- | --------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| `nvidia_nim`        | NVIDIA NIM            | `NVIDIA_NIM_API_KEY`                             | `nvidia_nim/nvidia/nemotron-3-super-120b-a12b`                |
| `open_router`       | OpenRouter            | `OPENROUTER_API_KEY`                             | `open_router/openrouter/free`                                 |
| `groq`              | Groq                  | `GROQ_API_KEY`                                   | `groq/llama-3.3-70b-versatile`                                |
| `cline_pass`        | ClinePass             | `CLINE_API_KEY`                                  | `cline_pass/cline-pass/kimi-k3`                               |
| `xai`               | xAI                   | `XAI_API_KEY`                                    | `xai/grok-4.5`                                                |
| `qwencloud`         | QwenCloud Token Plan  | `QWENCLOUD_API_KEY`                              | `qwencloud/qwen3.7-plus`                                      |
| `qwencloud_coding`  | QwenCloud Coding Plan | `QWENCLOUD_CODING_API_KEY`                       | `qwencloud_coding/qwen3.7-plus`                               |
| `together`          | Together AI           | `TOGETHER_API_KEY`                               | `together/zai-org/GLM-5.2`                                    |
| `deepinfra`         | DeepInfra             | `DEEPINFRA_API_KEY`                              | `deepinfra/deepseek-ai/DeepSeek-V4-Flash`                     |
| `siliconflow`       | SiliconFlow           | `SILICONFLOW_API_KEY`                            | `siliconflow/Qwen/Qwen3-32B`                                  |
| `nebius`            | Nebius Token Factory  | `NEBIUS_API_KEY`                                 | `nebius/Qwen/Qwen3-30B-A3B`                                   |
| `chutes`            | Chutes                | `CHUTES_API_KEY`                                 | `chutes/Qwen/Qwen3-32B-TEE`                                   |
| `featherless`       | Featherless AI        | `FEATHERLESS_API_KEY`                            | `featherless/Qwen/Qwen3-32B`                                  |
| `agnes`             | Agnes AI              | `AGNES_API_KEY`                                  | `agnes/agnes-2.0-flash`                                       |
| `zenmux`            | ZenMux                | `ZENMUX_API_KEY`                                 | `zenmux/deepseek/deepseek-v4-flash-free`                      |
| `wandb`             | W&B Inference         | `WANDB_API_KEY`                                  | `wandb/openai/gpt-oss-20b`                                    |
| `azure_openai`      | Azure OpenAI          | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL` | deployment name                                               |
| `gemini`            | Google AI Studio      | `GEMINI_API_KEY`                                 | `gemini/models/gemini-2.5-flash`                              |
| `deepseek`          | DeepSeek              | `DEEPSEEK_API_KEY`                               | `deepseek/deepseek-chat`                                      |
| `mistral`           | Mistral               | `MISTRAL_API_KEY`                                | `mistral/devstral-small-latest`                               |
| `mistral_codestral` | Mistral Codestral     | `CODESTRAL_API_KEY`                              | `mistral_codestral/codestral-latest`                          |
| `opencode_zen`      | OpenCode Zen          | `OPENCODE_API_KEY`                               | `opencode_zen/big-pickle`                                     |
| `opencode_go`       | OpenCode Go           | `OPENCODE_API_KEY`                               | `opencode_go/minimax-m2.7`                                    |
| `vercel`            | Vercel AI Gateway     | `AI_GATEWAY_API_KEY`                             | `vercel/openai/gpt-5.5`                                       |
| `bedrock`           | Amazon Bedrock        | `AWS_BEARER_TOKEN_BEDROCK`                       | `bedrock/openai.gpt-oss-120b`                                 |
| `huggingface`       | Hugging Face          | `HUGGINGFACE_API_KEY`                            | `huggingface/Qwen/Qwen3-Coder-480B-A35B-Instruct:fastest`     |
| `cohere`            | Cohere                | `COHERE_API_KEY`                                 | `cohere/command-a-plus-05-2026`                               |
| `github_models`     | GitHub Models         | `GITHUB_MODELS_TOKEN`                            | `github_models/openai/gpt-4.1`                                |
| `wafer`             | Wafer                 | `WAFER_API_KEY`                                  | `wafer/DeepSeek-V4-Pro`                                       |
| `kimi`              | Kimi API              | `KIMI_API_KEY`                                   | `kimi/kimi-k2.5`                                              |
| `kimi_code`         | Kimi Code             | `KIMI_CODE_API_KEY`                              | `kimi_code/k3`                                                |
| `minimax`           | MiniMax               | `MINIMAX_API_KEY`                                | `minimax/MiniMax-M3`                                          |
| `cerebras`          | Cerebras              | `CEREBRAS_API_KEY`                               | `cerebras/gpt-oss-120b`                                       |
| `sambanova`         | SambaNova             | `SAMBANOVA_API_KEY`                              | `sambanova/Meta-Llama-3.3-70B-Instruct`                       |
| `kilo`              | Kilo.ai               | `KILO_API_KEY`                                   | `kilo/kilo-auto/free`                                         |
| `fireworks`         | Fireworks AI          | `FIREWORKS_API_KEY`                              | `fireworks/accounts/fireworks/models/llama-v3p3-70b-instruct` |
| `novita`            | Novita AI             | `NOVITA_API_KEY`                                 | `novita/deepseek/deepseek-v4-flash-0731`                      |
| `cloudflare`        | Cloudflare Workers AI | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | `cloudflare/@cf/moonshotai/kimi-k2.6`                         |
| `zai`               | Z.ai Coding Plan      | `ZAI_API_KEY`                                    | `zai/glm-5.2`                                                 |
| `zai_api`           | Z.ai API              | `ZAI_API_KEY`                                    | `zai_api/glm-4.7-flash`                                       |
| `tokenrouter`       | TokenRouter           | `TOKENROUTER_API_KEY`                            | `tokenrouter/moonshotai/kimi-k3-free`                         |
| `nararoute`         | NaraRoute             | `NARAROUTE_API_KEY`                              | `nararoute/kimi-k3-free`                                      |
| `poolside`          | Poolside AI           | `POOLSIDE_API_KEY`                               | `poolside/poolside/laguna-s-2.1`                              |
| `llm7`              | LLM7.io               | `LLM7_API_KEY`                                   | `llm7/default`                                                |
| `ollama_cloud`      | Ollama Cloud          | `OLLAMA_API_KEY`                                 | `ollama_cloud/qwen3-coder:480b`                               |
| `ollama`            | Ollama (this machine) | `OLLAMA_BASE_URL`                                | `ollama/qwen2.5-coder:14b`                                    |
| `sglang`            | SGLang (this machine) | `SGLANG_BASE_URL`                                | `sglang/<served-id>`                                          |
| `tailscale_ollama`  | Ollama over Tailscale | `TAILSCALE_OLLAMA_BASE_URL`                      | `tailscale_ollama/<tag>`                                      |
| `tailscale_sglang`  | SGLang over Tailscale | `TAILSCALE_SGLANG_BASE_URL`                      | `tailscale_sglang/<served-id>`                                |
| `lmstudio`          | LM Studio             | `LM_STUDIO_BASE_URL`                             | local model id                                                |
| `llamacpp`          | llama.cpp             | `LLAMACPP_BASE_URL`                              | local model id                                                |

Free-tier availability is controlled by each vendor and can change. The catalog already drops models that cannot take tools. Zen free ids rotate; Autofind / Connect refreshes the live list.

Azure needs the full v1 endpoint as the extra field / `AZURE_OPENAI_BASE_URL`. Cloudflare needs an account id.

---

## Manual plugin load

If you skip the installer, build first, then point OpenCode at the plugin with a real `file://` URL (forward slashes; Windows is `file:///C:/...`, never `file://C:\...`).

```bash
npm install
npm run plugin:build
npm --prefix xx-stack/mcp-server run build
free-opencode start
```

`~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/free-opencode-hermes/packages/plugin/src/index.ts"]
}
```

The installer writes that URL for you via `scripts/host-setup.mjs`.

---

## Layout

| Path                           | Role                                                      |
| ------------------------------ | --------------------------------------------------------- |
| `packages/plugin/`             | OpenCode plugin, CLI, catalog, loopback proxy             |
| `xx-stack/`                    | Core: agents, skills, MCP routing, design and rules packs |
| `opencode-orchestration/`      | Linux OpenCode file install (`setup.sh`)                  |
| `hermes-orchestration/`        | Local-first Hermes proxy and lanes                        |
| `install-opencode.sh` / `.ps1` | OpenCode full setup                                       |
| `install-hermes.sh` / `.ps1`   | Hermes full setup                                         |
| `scripts/host-setup.mjs`       | Cross-platform plugin registration, wrappers, skill copy  |
| `inventory.example.json`       | Template for `inventory.json`                             |

---

## Troubleshooting

**`free-opencode` / `foc-opencode` / `opencode` not found.** New shell. Confirm `~/.local/bin` (and on Windows `~\.opencode\bin`) is on PATH. `foc-opencode` needs OpenCode 1.18.18+ (`opencode upgrade`). `foc-hermes` needs Hermes Agent 0.20.4+.

**`health: down`.** `free-opencode start`, then open [http://127.0.0.1:8082/health](http://127.0.0.1:8082/health). OpenCode also starts the proxy when the plugin loads.

**401 from the proxy.** Use `foc-opencode` so the child gets `FOC_OPENCODE_API_KEY`. The plugin also injects the token from `~/.free-opencode/config.json` (`proxyAuthToken`). Loopback requests with a missing token are allowed; a wrong-length Bearer is not.

**OpenCode still on `opencode/x-preview-f-free`.** A saved built-in model beat the plugin. Install writes `model: free-opencode/default` into `~/.config/opencode/opencode.json`. If it still sticks, use `foc-opencode` so `OPENCODE_CONFIG_CONTENT` overlay-forces the catalog.

**Empty `$` / `Read` / `Glob ""` loop.** OpenCode aborted a tool call with no
required arguments, or could not parse them. Quit the session. Restart the
proxy (`free-opencode stop` then `free-opencode start`) so you are not talking
to a stale `:8082`. Run `opencode` or `foc-opencode`. If an older
install copied xx-stack markdown over the native agent, `opencode` (plugin)
and `foc-opencode` unlink `~/.config/opencode/agents/build.md`, `plan.md`,
and `general.md` — start a **new** session after that. If it still loops, the
upstream is weak at tools — in Admin, **Use** Groq, NIM, or a bigger coder
instead of a tiny flash model.

**Empty model picker / no local boxes.** Self-hosted lanes are not assumed running. In Admin, Self-hosted is at the **bottom**. Click **Autofind**, or Connect Ollama / SGLang / Tailscale by hand. Same from the CLI: `free-opencode autofind` or `free-opencode connect ollama`. Tailscale Ollama needs `OLLAMA_HOST` on the box bound to the tailnet, not `127.0.0.1`.

**Remove then Apply brings a box back.** That is fixed: Remove takes self-hosted cards off the list and drops their models. Apply does not reconnect from a leftover default URL. Autofind or Connect puts a box back.

**No free models in Admin.** Connect OpenCode Zen (`OPENCODE_API_KEY`) or OpenRouter. Then **Use** on a free row, or `free-opencode models --free`.

**Admin 403.** It only accepts loopback. Use `127.0.0.1`, not a LAN IP.

**Windows plugin not loading.** The `plugin` entry must be `file:///C:/...`. Re-run `node scripts/host-setup.mjs opencode-host`.

**`missing mcp-server directory at ~/.config/opencode/skills/xx-stack/mcp-server`.** That comes from the legacy `opencode-orchestration/setup.sh`, which expected a copied stack under OpenCode's skills dir. `./install-opencode.sh` does not use that path anymore. Re-run the installer; it registers MCP against `xx-stack/mcp-server` in this repo.

**Hermes `xx-hermes` exits.** Hermes Agent not on PATH, or empty `HERMES_PROXY_TOKEN` in `~/.config/hermes-orchestration/proxy.env`. Re-run the Hermes installer.

**Hermes `foc-hermes` exits.** Catalog proxy down and could not auto-start, empty catalog (connect a provider), Hermes older than 0.20.4, a detached subcommand (`gateway` / `serve` / …), or an existing `HERMES_MANAGED_DIR`. For GPU/Ollama lanes use `xx-hermes`, not `foc-hermes`.

**Work going to the cloud.** That is opt-in. Check `inventory.json` → `policy.cloudEscalation.optIn` and `XX_STACK_ALLOW_CLOUD`. The OpenCode proxy will use any provider you gave a key for; that is separate from xx-stack machine routing.

---

## Develop

```bash
npm install
npm run plugin:test
npm test
npm run hermes:test
```

GitHub Actions is off for this repo. Run tests locally. `npm run verify` still exists for a full local gate.

---

## License

MIT. See [LICENSE](LICENSE).
