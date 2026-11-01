import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "@opencode-ai/plugin";

import { applyEnvOverrides, loadSettings, type Settings } from "../config/settings.js";
import { catalogModelConfig } from "../launchers/opencode-config.js";
import { nodeExecutable, opencodeConfigDir } from "../platform.js";
import {
  CATALOG_MODEL_ID,
  mcpServerEntrypoint,
  PROVIDER_ID,
  repoRoot,
  TOKEN_ENV,
  xxStackDir,
} from "../paths.js";
import { loadRuntimeAgents, loadSharedInstructions, type InjectedAgent } from "./agents.js";
import {
  isLaneAgentName,
  listReadyLocalLanes,
  pickOrchestratorLane,
  type ParallelLane,
} from "./lanes.js";
import { appendLog } from "../proxy/route-log.js";

/**
 * xx-stack markdown `steps` (12–28) is a different budget than OpenCode's.
 * OpenCode counts every tool call; when `steps` is hit it injects
 * CRITICAL-MAXIMUM-STEPS-REACHED, disables tools, and the model spirals on
 * text. Native build/plan/general omit `steps` so the loop runs until the
 * model stops. Subagents still get this floor so a reviewer cannot run away.
 */
export const OPENCODE_AGENT_STEPS_FLOOR = 120;
const DISABLED_HOST_AGENTS = new Set(["ping", "planning", "researcher"]);
const OPENCODE_NATIVE_PRIMARIES = new Set(["build", "plan", "general"]);
/** xx-stack unattended orchestrators: primary, MCP task tools, halt rule. */
const ORCHESTRATOR_AGENTS = new Set(["execution-orchestrator", "parallel-execution-orchestrator"]);
/** Native primaries plus orchestrators — omit OpenCode `steps`. */
const UNBOUNDED_STEPS_AGENTS = new Set([...OPENCODE_NATIVE_PRIMARIES, ...ORCHESTRATOR_AGENTS]);

/** MCP tools the unattended orchestrators must keep; abort stays off. */
const ORCHESTRATOR_MCP_TOOLS = [
  "task_create",
  "task_update",
  "task_get",
  "task_list",
  "task_suspend",
  "supervisor_start_session",
  "supervisor_tick",
  "supervisor_complete_session",
  "supervisor_record_event",
  "supervisor_record_completion_check",
  "search_tools",
  "list_platforms",
  "check_health",
  "route_task",
  "route_parallel_tasks",
] as const;

const ORCHESTRATOR_HALT =
  "When the user request is fully done, output exactly one line starting with DONE: and stop. " +
  "Do not send another message. Do not confirm DONE. Do not restate commit hashes, verify, or " +
  '"session closed" / "nothing further to do". If your previous assistant message already said ' +
  "DONE, session closed, nothing further, or a final recap, output only STOP with no tools.";

/** Object-valued config field as a fresh record; anything else (unset, string, array) → {}. */
function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/** Existing permission with bash/edit forced to allow (unattended agents must not prompt). */
function allowBashAndEdit(permission: unknown): Record<string, unknown> {
  return { ...recordOf(permission), bash: "allow", edit: "allow" };
}

function enableOrchestratorMcpTools(def: AgentConfig): void {
  const tools = recordOf(def.tools);
  for (const name of ORCHESTRATOR_MCP_TOOLS) tools[name] = true;
  tools.supervisor_abort_session = false;
  def.tools = tools;
}

/** Markdown names that replace OpenCode's native build/plan/general tools. */
const OPENCODE_NATIVE_PRIMARY_FILES = ["build.md", "plan.md", "general.md"] as const;
const PLUGIN_TOOLS = ["foc_status", "foc_models"] as const;

/** Marker that tells applyRuntimeExtras the tool-use prefix is already present. */
const TOOL_USE_MARKER = "Free OpenCode is routing models";

/**
 * Global instructions instead of per-agent prompts: a two-line `agent.*.prompt`
 * stub (or xx-stack `build.md`) replaces OpenCode's native tool instructions and
 * the model falls back to empty Read/$ calls. Native primaries omit `prompt` so
 * the built-in agent keeps its schemas.
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

/**
 * Pin agents to free-opencode/default so xx-stack pins like ollama-local/* stay
 * valid. Parallel lane workers (`lane-*`) keep their concrete host model.
 */
export function pinAgentsToCatalog(config: MutableConfig): void {
  const model = catalogModelRef();
  if (!config.agent || typeof config.agent !== "object") return;
  for (const [name, def] of Object.entries(config.agent as Record<string, AgentConfig>)) {
    if (!def || typeof def !== "object") continue;
    if (isLaneAgentName(name)) continue;
    def.model = model;
  }
}

const LANE_WORKER_PROMPT =
  "You are a Free OpenCode **parallel lane worker** pinned to one self-hosted box. " +
  "Execute only the assigned independent slice. Prefer tools over speculation. " +
  "Do not spawn further parallel waves. When the slice is done, summarize files " +
  "changed and checks run, then stop.";

/** Advertise each ready local as a selectable free-opencode/<provider>/<model>. */
function localLaneModelEntries(
  settings: Settings
): Record<string, { name: string; reasoning?: boolean }> {
  const out: Record<string, { name: string; reasoning?: boolean }> = {};
  for (const lane of listReadyLocalLanes(settings)) {
    out[lane.slug] = {
      name: `Lane · ${lane.displayName}`,
      reasoning: true,
    };
  }
  return out;
}

/** Register Task-able subagents pinned to distinct local hosts. */
export function registerParallelLaneAgents(
  config: MutableConfig,
  settings: Settings = applyEnvOverrides(loadSettings())
): ParallelLane[] {
  const lanes = listReadyLocalLanes(settings);
  if (lanes.length === 0) return [];
  config.agent = config.agent ?? {};
  const agents = config.agent as Record<string, AgentConfig>;
  for (const lane of lanes) {
    const existing = (agents[lane.agentName] ?? {}) as AgentConfig;
    agents[lane.agentName] = {
      ...existing,
      description: `Parallel lane on ${lane.displayName} (pinned host worker).`,
      mode: "subagent",
      hidden: false,
      disable: false,
      model: lane.wireModel,
      temperature: 0,
      prompt: LANE_WORKER_PROMPT,
      steps: openCodeAgentSteps(existing.steps),
      permission: allowBashAndEdit(existing.permission),
    };
  }
  return lanes;
}

/**
 * Weakest-as-orchestrator: pin parallel-execution-orchestrator to the lightest
 * ready local so stronger boxes stay free for concurrent Task workers.
 */
export function pinParallelOrchestratorToWeakestLane(
  config: MutableConfig,
  lanes: ParallelLane[]
): ParallelLane | null {
  const weakest = pickOrchestratorLane(lanes);
  if (!weakest) return null;
  const agents = config.agent as Record<string, AgentConfig> | undefined;
  const orch = agents?.["parallel-execution-orchestrator"];
  if (!orch || typeof orch !== "object") return null;
  orch.model = weakest.wireModel;
  return weakest;
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
      disable: false,
      hidden: false,
      mode: "primary",
      permission: allowBashAndEdit(existing.permission),
    };
    delete next.prompt;
    delete next.steps;
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
    const next = recordOf(def.tools);
    for (const name of PLUGIN_TOOLS) next[name] = true;
    def.tools = next;
  }
}

/** Slash commands; a user-defined command of the same name wins. */
const FOC_COMMANDS: Record<string, { template: string; description: string; agent?: string }> = {
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

export function applyRuntimeExtras(config: MutableConfig): void {
  registerPlatformRoutingMcp(config);
  mergeRuntimeAgents(config);
  normalizeAgentLimits(config);
  pinAgentsToCatalog(config);
  const settings = applyEnvOverrides(loadSettings());
  const lanes = registerParallelLaneAgents(config, settings);
  pinParallelOrchestratorToWeakestLane(config, lanes);
  enablePluginTools(config);

  config.command = config.command ?? {};
  for (const [name, command] of Object.entries(FOC_COMMANDS)) {
    if (!config.command[name]) config.command[name] = command;
  }
  appendToolUseInstructions(config);
}

function registerPlatformRoutingMcp(config: MutableConfig): void {
  const mcpPath = mcpServerEntrypoint();
  if (!existsSync(mcpPath)) return;
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
  void appendLog("mcp.spawn", { command: [nodeExecutable(), mcpPath] });
}

/** Overlay xx-stack markdown agents onto whatever the user's config already defines. */
function mergeRuntimeAgents(config: MutableConfig): void {
  config.agent = config.agent ?? {};
  const agents = config.agent as Record<string, AgentConfig>;
  for (const agent of loadRuntimeAgents()) {
    const existing = agents[agent.name] ?? {};
    agents[agent.name] = OPENCODE_NATIVE_PRIMARIES.has(agent.name)
      ? mergeNativePrimary(existing, agent)
      : mergeStackAgent(existing, agent);
  }
}

/** Native build/plan/general keep OpenCode's own prompt and an unbounded loop. */
function mergeNativePrimary(existing: AgentConfig, agent: InjectedAgent): AgentConfig {
  const native: AgentConfig = {
    ...existing,
    description: agent.description ?? existing.description,
    mode: "primary",
    temperature: agent.temperature ?? existing.temperature,
    permission: { ...recordOf(existing.permission), ...agent.permission },
  };
  delete native.prompt;
  delete native.steps;
  return native;
}

function mergeStackAgent(existing: AgentConfig, agent: InjectedAgent): AgentConfig {
  const merged: AgentConfig = {
    ...existing,
    prompt: agent.prompt,
    description: agent.description ?? existing.description,
    mode: agent.mode ?? existing.mode ?? "subagent",
    temperature: agent.temperature ?? existing.temperature,
    permission: { ...recordOf(existing.permission), ...agent.permission },
  };
  if (UNBOUNDED_STEPS_AGENTS.has(agent.name)) {
    delete merged.steps;
  } else {
    merged.steps = openCodeAgentSteps(existing.steps ?? agent.steps);
  }
  if (ORCHESTRATOR_AGENTS.has(agent.name)) applyOrchestratorPolicy(merged);
  return merged;
}

/** Unattended orchestrators: primary, may delegate any Task, and must halt cleanly. */
function applyOrchestratorPolicy(def: AgentConfig): void {
  enableOrchestratorMcpTools(def);
  if (typeof def.prompt === "string" && !def.prompt.includes("output only STOP")) {
    def.prompt = `${def.prompt}\n\n## Halt\n\n${ORCHESTRATOR_HALT}\n`;
  }
  const permission = recordOf(def.permission);
  permission.edit = "allow";
  permission.bash = "allow";
  permission.task = { ...recordOf(permission.task), "*": "allow" };
  def.permission = permission;
  def.mode = "primary";
}

/** Every agent: OpenCode steps floor (or none for unbounded); host-only agents stay hidden. */
function normalizeAgentLimits(config: MutableConfig): void {
  const agents = (config.agent ?? {}) as Record<string, AgentConfig>;
  for (const [name, def] of Object.entries(agents)) {
    if (!def || typeof def !== "object") continue;
    if (UNBOUNDED_STEPS_AGENTS.has(name)) {
      delete def.steps;
    } else {
      def.steps = openCodeAgentSteps(def.steps);
    }
    if (DISABLED_HOST_AGENTS.has(name)) {
      def.hidden = true;
      def.disable = true;
      def.mode = "subagent";
    }
  }
}

function appendToolUseInstructions(config: MutableConfig): void {
  const { instruction } = config;
  const already = Array.isArray(instruction)
    ? instruction.some((line) => line.includes(TOOL_USE_MARKER))
    : typeof instruction === "string" && instruction.includes(TOOL_USE_MARKER);
  if (already) return;
  const shared = loadSharedInstructions();
  const prefix = shared ? TOOL_USE_PREFIX + shared : TOOL_USE_PREFIX;
  if (Array.isArray(instruction)) instruction.push(prefix);
  else if (typeof instruction === "string") config.instruction = `${instruction}\n\n${prefix}`;
  else config.instruction = prefix;
}

export function injectOpenCodeConfig(config: MutableConfig): void {
  stripNativePrimaryAgentFiles();
  const settings = applyEnvOverrides(loadSettings());
  const models = {
    ...catalogModelConfig(),
    ...localLaneModelEntries(settings),
  } as Record<string, { name: string; reasoning?: boolean }>;

  const token = settings.proxyAuthToken;
  config.provider = config.provider ?? {};
  config.provider[PROVIDER_ID] = {
    name: "Free OpenCode",
    npm: "@ai-sdk/openai",
    env: [TOKEN_ENV],
    options: {
      baseURL: proxyBaseUrl(),
      apiKey: token,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
    models,
  };

  restrictToFreeOpenCodeProvider(config);
  applyRuntimeExtras(config);
  neutralizeVendorAgents(config);
  config.permission = {
    ...(config.permission ?? {}),
    bash: "allow",
    edit: "allow",
  };
}

/** Zen model refs that must not win the picker. big-pickle is OpenCode's free default. */
const ZEN_MODEL_RE = /^(opencode(\/|@)|opencode-zen(\/|@)|big-pickle(\/|@)|big-pickle$)/;

export function isZenModelRef(raw: unknown): boolean {
  return typeof raw === "string" && Boolean(raw.trim()) && ZEN_MODEL_RE.test(raw.trim());
}

/**
 * Would the OpenCode config that OpenCode actually loads still default to Zen?
 * True when the model/small_model point at a Zen ref (or are unset) or the
 * provider restrictions are missing. With the plugin overlay loaded this is
 * false, because injectOpenCodeConfig pins the picker; the warning is for a
 * session where the plugin has not run yet (add-on not reloaded, or a config
 * that predates the overlay).
 */
export function loadedConfigDefaultsToZen(home?: string): boolean {
  try {
    const raw = readFileSync(join(opencodeConfigDir(home), "opencode.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      model?: unknown;
      small_model?: unknown;
      enabled_providers?: unknown;
      disabled_providers?: unknown;
    };
    if (isZenModelRef(parsed.model) || isZenModelRef(parsed.small_model)) return true;
    if (typeof parsed.model !== "string" || !parsed.model.trim()) return true;
    const enabled = Array.isArray(parsed.enabled_providers)
      ? (parsed.enabled_providers as unknown[]).filter((v): v is string => v === PROVIDER_ID)
      : [];
    if (enabled.length === 0) return true;
    const disabled = Array.isArray(parsed.disabled_providers)
      ? (parsed.disabled_providers as unknown[])
      : [];
    if (!disabled.includes("opencode")) return true;
    return false;
  } catch {
    // No config yet — a fresh opencode session uses OpenCode's Zen default.
    return true;
  }
}

/** True when the picker already points at the Free OpenCode provider (catalog or a lane). */
export function isFreeOpenCodeModelRef(raw: unknown): boolean {
  return typeof raw === "string" && raw.trim().startsWith(`${PROVIDER_ID}/`);
}

/**
 * Pin the picker to the free-opencode provider. This mirrors what the
 * foc-opencode launcher overlay does, so a bare `opencode` session (which loads
 * ~/.config/opencode/opencode.json) cannot default to Zen or a leftover
 * SGLang/Groq slug: enabled_providers carries only free-opencode, opencode
 * stays in disabled_providers, and model/small_model are rewritten to the
 * catalog unless they already name a free-opencode slug. Leaving a foreign
 * model (e.g. sglang/qwen3-coder-next) with only free-opencode enabled makes
 * OpenCode v2 show "No provider selected".
 */
export function restrictToFreeOpenCodeProvider(config: MutableConfig): void {
  config.enabled_providers = [PROVIDER_ID];
  const disabled = (config.disabled_providers ?? []).filter((id) => id !== PROVIDER_ID);
  if (!disabled.includes("opencode")) disabled.push("opencode");
  config.disabled_providers = disabled;

  const catalog = catalogModelRef();
  if (!isFreeOpenCodeModelRef(config.model)) config.model = catalog;
  if (!isFreeOpenCodeModelRef(config.small_model)) config.small_model = catalog;
}
