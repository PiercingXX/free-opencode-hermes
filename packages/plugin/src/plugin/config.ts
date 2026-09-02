import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "@opencode-ai/plugin";

import { applyEnvOverrides, loadSettings, readyProviderIds } from "../config/settings.js";
import { catalogClientModel, modelConfigEntry } from "../launchers/opencode-config.js";
import { nodeExecutable, opencodeConfigDir } from "../platform.js";
import {
  CATALOG_MODEL_ID,
  mcpServerEntrypoint,
  PROVIDER_ID,
  repoRoot,
  xxStackDir,
} from "../paths.js";
import { loadRuntimeAgents, loadSharedInstructions } from "./agents.js";

/**
 * xx-stack `steps` is a different budget than OpenCode's. OpenCode counts
 * every tool call. The markdown copies under ~/.config/opencode/agents/ still
 * ship 12–28, which a few empty bash/read/glob calls exhaust. Then OpenCode
 * injects CRITICAL-MAXIMUM-STEPS-REACHED (tools disabled) and the model
 * loops on that prompt.
 */
export const OPENCODE_AGENT_STEPS_FLOOR = 120;
const DISABLED_HOST_AGENTS = new Set(["ping", "planning", "researcher"]);
const OPENCODE_NATIVE_PRIMARIES = new Set(["build", "plan", "general"]);
/** Markdown names that replace OpenCode's native build/plan/general tools. */
export const OPENCODE_NATIVE_PRIMARY_FILES = ["build.md", "plan.md", "general.md"] as const;
const PLUGIN_TOOLS = ["foc_status", "foc_models"] as const;

/**
 * The catalog overlay does not set `agent.*.prompt`. A two-line stub (or xx-stack `build.md`)
 * replaces OpenCode's native tool instructions and the model falls back to empty
 * Read/$ calls. Native primaries omit `prompt` so the built-in agent keeps its schemas.
 */

const TOOL_USE_PREFIX =
  "Free OpenCode is routing models through the local proxy. Prefer xx-stack routing tools when work should run on another machine you own. Cloud stays opt-in.\n\n" +
  "Every tool call must include the required arguments from that tool's schema. Empty bash/read/glob/grep calls are aborted and must not be retried empty.\n" +
  '- bash requires {"command": "<shell command>"}\n' +
  '- read requires {"filePath": "<absolute path>"}\n' +
  '- glob requires {"pattern": "<glob>"}\n' +
  '- grep requires {"pattern": "<search>"}\n' +
  "foc_status and foc_models have no required arguments — call them with {}.\n" +
  'To inspect a repo, call glob with pattern "*" or read the README with filePath set. Never call bash or read with no arguments.\n\n';

type AgentConfig = {
  prompt?: string;
  description?: unknown;
  mode?: unknown;
  temperature?: unknown;
  steps?: unknown;
  model?: unknown;
  permission?: unknown;
  hidden?: unknown;
  disable?: unknown;
  [key: string]: unknown;
};

export type MutableConfig = Config & {
  provider?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  command?: Record<string, unknown>;
  instruction?: string | string[];
  model?: string;
  small_model?: string;
  enabled_providers?: string[];
  disabled_providers?: string[];
  tools?: Record<string, boolean>;
  permission?: Record<string, unknown>;
};

export function catalogModelRef(): string {
  return `${PROVIDER_ID}/${CATALOG_MODEL_ID}`;
}

/** OpenCode only advertises free-opencode/default. xx-stack pins like ollama-local/* are invalid. */
export function pinAgentsToCatalog(config: MutableConfig): void {
  const model = catalogModelRef();
  if (!config.agent || typeof config.agent !== "object") return;
  for (const def of Object.values(config.agent as Record<string, AgentConfig>)) {
    if (!def || typeof def !== "object") continue;
    def.model = model;
  }
}

export function catalogAgentOverlay(
  agentNames: Iterable<string>
): Record<string, { model: string }> {
  const model = catalogModelRef();
  const out: Record<string, { model: string }> = {};
  for (const name of agentNames) {
    if (name.trim()) out[name] = { model };
  }
  return out;
}

export function vendorAgentNames(): string[] {
  const names = new Set<string>(DISABLED_HOST_AGENTS);
  for (const agent of loadRuntimeAgents()) names.add(agent.name);
  return [...names];
}

/**
 * Keep OpenCode's native build/plan/general tools. xx-stack agents stay
 * available as subagents; only ping/planning/researcher stay hidden.
 */
export function neutralizeVendorAgents(config: MutableConfig): void {
  config.agent = config.agent ?? {};
  const agents = config.agent as Record<string, AgentConfig>;
  for (const name of OPENCODE_NATIVE_PRIMARIES) {
    const existing = (agents[name] ?? {}) as AgentConfig;
    const next: AgentConfig = {
      ...existing,
      model: catalogModelRef(),
      steps: OPENCODE_AGENT_STEPS_FLOOR,
      disable: false,
      hidden: false,
      mode: "primary",
      permission: {
        ...((existing.permission as Record<string, unknown> | undefined) ?? {}),
        bash: "allow",
        edit: "allow",
      },
    };
    delete next.prompt;
    agents[name] = next;
  }
  for (const name of DISABLED_HOST_AGENTS) {
    const existing = (agents[name] ?? {}) as AgentConfig;
    agents[name] = {
      ...existing,
      disable: true,
      hidden: true,
      mode: "subagent",
    };
  }
}

/** Process-local overlay for foc-opencode: pin natives, do not hide xx-stack. */
export function fccStyleAgentOverlay(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const name of OPENCODE_NATIVE_PRIMARIES) {
    out[name] = {
      model: catalogModelRef(),
      steps: OPENCODE_AGENT_STEPS_FLOOR,
      disable: false,
      hidden: false,
      mode: "primary",
      permission: { bash: "allow", edit: "allow" },
    };
  }
  return out;
}

/**
 * Remove leftover xx-stack copies of OpenCode's native primary agents.
 *
 * Install used to copy `build.md` / `plan.md` / `general.md` into
 * `~/.config/opencode/agents/`. OpenCode loads those files before the plugin
 * overlay runs, so omitting `prompt` in config is not enough for an existing
 * install. Unlink is idempotent.
 */
export function stripNativePrimaryAgentFiles(home?: string): string[] {
  const dir = join(opencodeConfigDir(home), "agents");
  const removed: string[] = [];
  for (const name of OPENCODE_NATIVE_PRIMARY_FILES) {
    const target = join(dir, name);
    try {
      unlinkSync(target);
      removed.push(name);
    } catch {
      // missing, or not writable — next launch / reinstall can retry
    }
  }
  return removed;
}

export function userConfiguredAgentNames(home?: string): string[] {
  const names = new Set<string>();
  const dir = opencodeConfigDir(home);
  for (const file of ["config.json", "opencode.json"]) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        agent?: Record<string, unknown>;
      };
      for (const name of Object.keys(parsed.agent ?? {})) {
        if (name.trim()) names.add(name);
      }
    } catch {
      // missing or invalid
    }
  }
  return [...names];
}

export function openCodeAgentSteps(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return OPENCODE_AGENT_STEPS_FLOOR;
  return Math.max(n, OPENCODE_AGENT_STEPS_FLOOR);
}

export function proxyBaseUrl(): string {
  const settings = applyEnvOverrides(loadSettings());
  return `http://${settings.listen.host}:${settings.listen.port}/v1`;
}

function enablePluginTools(config: MutableConfig): void {
  const tools = { ...(config.tools ?? {}) };
  for (const name of PLUGIN_TOOLS) tools[name] = true;
  config.tools = tools;
  const agents = config.agent as Record<string, AgentConfig> | undefined;
  if (!agents) return;
  for (const def of Object.values(agents)) {
    if (!def || typeof def !== "object") continue;
    const current =
      def.tools && typeof def.tools === "object" && !Array.isArray(def.tools)
        ? (def.tools as Record<string, unknown>)
        : {};
    const next = { ...current };
    for (const name of PLUGIN_TOOLS) next[name] = true;
    def.tools = next;
  }
}

export function applyRuntimeExtras(config: MutableConfig): void {
  const mcpPath = mcpServerEntrypoint();
  if (existsSync(mcpPath)) {
    config.mcp = config.mcp ?? {};
    config.mcp["xx-stack-platform-routing"] = {
      type: "local",
      enabled: true,
      command: [nodeExecutable(), mcpPath],
      environment: {
        XX_STACK_REPO: xxStackDir(),
        FREE_OPENCODE_REPO: repoRoot(),
      },
    };
  }

  config.agent = config.agent ?? {};
  for (const agent of loadRuntimeAgents()) {
    const existing = (config.agent[agent.name] ?? {}) as AgentConfig;
    if (OPENCODE_NATIVE_PRIMARIES.has(agent.name)) {
      const native: AgentConfig = {
        ...existing,
        description: agent.description ?? existing.description,
        mode: "primary",
        temperature: agent.temperature ?? existing.temperature,
        permission: {
          ...(typeof existing.permission === "object" && existing.permission
            ? (existing.permission as Record<string, unknown>)
            : {}),
          ...agent.permission,
        },
        steps: openCodeAgentSteps(existing.steps ?? agent.steps),
      };
      delete native.prompt;
      (config.agent as Record<string, AgentConfig>)[agent.name] = native;
      continue;
    }
    const merged: AgentConfig = {
      ...existing,
      prompt: agent.prompt,
      description: agent.description ?? existing.description,
      mode: agent.mode ?? existing.mode ?? "subagent",
      temperature: agent.temperature ?? existing.temperature,
      permission: {
        ...(typeof existing.permission === "object" && existing.permission
          ? (existing.permission as Record<string, unknown>)
          : {}),
        ...agent.permission,
      },
      steps: openCodeAgentSteps(existing.steps ?? agent.steps),
    };
    (config.agent as Record<string, AgentConfig>)[agent.name] = merged;
  }
  const agents = config.agent as Record<string, AgentConfig>;
  for (const [name, def] of Object.entries(agents)) {
    if (!def || typeof def !== "object") continue;
    def.steps = openCodeAgentSteps(def.steps);
    if (DISABLED_HOST_AGENTS.has(name)) {
      def.hidden = true;
      def.disable = true;
      def.mode = "subagent";
    }
  }
  pinAgentsToCatalog(config);
  enablePluginTools(config);

  config.command = config.command ?? {};
  const commands: Record<string, { template: string; description: string; agent?: string }> = {
    "foc-plan": {
      template: "Create an implementation plan for: $ARGUMENTS",
      description: "Plan a change with the xx-stack plan agent",
      agent: "plan",
    },
    "foc-build": {
      template: "Implement this task with quality gates: $ARGUMENTS",
      description: "Implement with the xx-stack build agent",
      agent: "build",
    },
    "foc-review": {
      template: "Review the current changes for production bugs and missing tests: $ARGUMENTS",
      description: "Review with the xx-stack reviewer agent",
      agent: "reviewer",
    },
    "foc-orchestrate": {
      template: "Orchestrate this work to completion: $ARGUMENTS",
      description: "Run the xx-stack execution orchestrator",
      agent: "execution-orchestrator",
    },
  };
  for (const [name, command] of Object.entries(commands)) {
    if (!config.command[name]) config.command[name] = command;
  }

  const shared = loadSharedInstructions();
  const prefix = shared ? TOOL_USE_PREFIX + shared : TOOL_USE_PREFIX;
  const already =
    (typeof config.instruction === "string" && config.instruction.includes("Free OpenCode is routing models")) ||
    (Array.isArray(config.instruction) &&
      config.instruction.some((line) => line.includes("Free OpenCode is routing models")));
  if (!already) {
    if (Array.isArray(config.instruction)) config.instruction.push(prefix);
    else if (typeof config.instruction === "string")
      config.instruction = `${config.instruction}\n\n${prefix}`;
    else config.instruction = prefix;
  }
}

export function injectOpenCodeConfig(config: MutableConfig): void {
  stripNativePrimaryAgentFiles();
  const settings = applyEnvOverrides(loadSettings());
  const catalog = catalogClientModel();
  const models: Record<string, { name: string; reasoning?: boolean }> = {
    [catalog.wireSlug]: modelConfigEntry(catalog) as { name: string; reasoning?: boolean },
  };

  const token = settings.proxyAuthToken;
  config.provider = config.provider ?? {};
  config.provider[PROVIDER_ID] = {
    name: "Free OpenCode",
    npm: "@ai-sdk/openai",
    options: {
      baseURL: proxyBaseUrl(),
      apiKey: token,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
    models,
  };

  const defaultModel = catalogModelRef();
  config.model = defaultModel;
  config.small_model = defaultModel;
  restrictToFreeOpenCodeProvider(config);
  applyRuntimeExtras(config);
  neutralizeVendorAgents(config);
  config.permission = {
    ...(config.permission ?? {}),
    bash: "allow",
    edit: "allow",
  };
  void readyProviderIds(settings);
}

/** Hide OpenCode Zen/built-ins and every other models.dev provider. */
export function restrictToFreeOpenCodeProvider(config: MutableConfig): void {
  config.enabled_providers = [PROVIDER_ID];
  const disabled = (config.disabled_providers ?? []).filter((id) => id !== PROVIDER_ID);
  if (!disabled.includes("opencode")) disabled.push("opencode");
  config.disabled_providers = disabled;
}
