import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

import { applyEnvOverrides, loadSettings, readyProviderIds } from "./config/settings.js";
import { OPENCODE_LAUNCHER_TOKEN_ENV, PROVIDER_ID, TOKEN_ENV } from "./paths.js";
import { buildAuthHook, ensureFreeOpenCodeAuth } from "./plugin/auth.js";
import { injectOpenCodeConfig } from "./plugin/config.js";
import { listReadyLocalLanes, pickOrchestratorLane } from "./plugin/lanes.js";
import {
  ensureProxyInProcess,
  exportProxyToken,
  proxyUrlFromSettings,
} from "./plugin/lifecycle.js";
import { buildModelCatalog, defaultListedModels } from "./proxy/models.js";

async function bootProxyAndAuth(): Promise<void> {
  exportProxyToken();
  try {
    ensureFreeOpenCodeAuth(applyEnvOverrides(loadSettings()).proxyAuthToken);
  } catch {
    // auth.json is best-effort; config.provider.options.apiKey still applies.
  }
  try {
    await ensureProxyInProcess();
  } catch {
    // OpenCode still loads; Admin/CLI can start the proxy later.
  }
}

/** OpenCode v2 plugin setup. V1 implementations do not run on 2.x. */
async function setupOpenCodeV2(ctx: {
  catalog?: { transform: (fn: (editor: unknown) => void) => unknown };
  provider?: { transform: (fn: (editor: unknown) => void) => unknown };
}): Promise<void> {
  await bootProxyAndAuth();
  const settings = applyEnvOverrides(loadSettings());
  const token = settings.proxyAuthToken;
  const baseURL = `${proxyUrlFromSettings()}/v1`;
  const register = (editor: unknown): void => {
    const add = (editor as { add?: (row: unknown) => void }).add;
    if (typeof add === "function") {
      (add as (row: unknown) => void)({
        info: {
          id: PROVIDER_ID,
          name: "Free OpenCode",
          activation: "enabled",
          package: "@ai-sdk/openai-compatible",
          env: [TOKEN_ENV],
          settings: { baseURL, apiKey: token },
        },
        models: [
          {
            id: "default",
            name: "Free OpenCode",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
          },
        ],
      });
    }
  };
  if (ctx.provider?.transform) await ctx.provider.transform(register);
  else if (ctx.catalog?.transform) await ctx.catalog.transform(register);
}

export const FreeOpenCodePlugin: Plugin = async () => {
  await bootProxyAndAuth();

  return {
    auth: buildAuthHook(),
    config: async (config): Promise<void> => {
      injectOpenCodeConfig(config);
    },
    "shell.env": async (_input, output): Promise<void> => {
      const settings = applyEnvOverrides(loadSettings());
      output.env[TOKEN_ENV] = settings.proxyAuthToken;
      output.env[OPENCODE_LAUNCHER_TOKEN_ENV] = settings.proxyAuthToken;
    },
    "tool.execute.before": async (input, output): Promise<void> => {
      const name = String(input.tool || "").toLowerCase();
      const args =
        output.args && typeof output.args === "object" && !Array.isArray(output.args)
          ? { ...(output.args as Record<string, unknown>) }
          : {};
      if (name === "glob" && !String(args.pattern ?? "").trim()) args.pattern = "*";
      if (name === "list" && !String(args.path ?? "").trim()) args.path = ".";
      if (name === "read") {
        const path = String(args.filePath ?? args.path ?? "").trim();
        if (path) args.filePath = path;
      }
      if ((name === "bash" || name === "shell") && !String(args.command ?? "").trim()) {
        args.command = "ls -la";
      }
      output.args = args;
    },
    tool: {
      foc_status: tool({
        description:
          "Show Free OpenCode proxy status, ready providers, parallel local lanes, and default model. No required arguments; call with {}.",
        args: {
          verbose: tool.schema
            .boolean()
            .optional()
            .describe("If true, include fallbacks. Default false."),
        },
        async execute(args) {
          try {
            const settings = applyEnvOverrides(loadSettings());
            const ready = readyProviderIds(settings);
            const lanes = listReadyLocalLanes(settings);
            const orchestrator = pickOrchestratorLane(lanes);
            const body: Record<string, unknown> = {
              provider: PROVIDER_ID,
              url: proxyUrlFromSettings(),
              defaultModel: settings.model,
              readyProviders: ready,
              parallelLanes: lanes.map((lane) => ({
                agent: lane.agentName,
                model: lane.wireModel,
                slug: lane.slug,
                strength: lane.strength,
              })),
              orchestratorLane: orchestrator
                ? { agent: "parallel-execution-orchestrator", model: orchestrator.wireModel }
                : null,
            };
            if (args.verbose) body.fallbacks = settings.fallbacks;
            return {
              title: "Free OpenCode status",
              output: JSON.stringify(body, null, 2),
            };
          } catch (error) {
            return {
              title: "Free OpenCode status",
              output: error instanceof Error ? error.message : String(error),
            };
          }
        },
      }),
      foc_models: tool({
        description:
          "List models and parallel lane agents (lane-*) for ready self-hosted boxes. Call with {}.",
        args: {
          refresh: tool.schema
            .boolean()
            .optional()
            .describe("If true, re-probe providers. Default uses the last saved catalog."),
        },
        async execute(args) {
          try {
            const settings = applyEnvOverrides(loadSettings());
            const models = args.refresh
              ? await buildModelCatalog(settings)
              : defaultListedModels(settings);
            const lanes = listReadyLocalLanes(settings);
            const modelLines =
              models.map((m) => m.id).join("\n") || "No models yet. Connect a provider.";
            const laneLines =
              lanes.length === 0
                ? "No local parallel lanes ready."
                : lanes
                    .map(
                      (lane) =>
                        `${lane.agentName}\t${lane.wireModel}\tstrength=${lane.strength}`
                    )
                    .join("\n");
            return {
              title: "Free OpenCode models",
              output: `Models:\n${modelLines}\n\nParallel lanes (Task subagent_type):\n${laneLines}`,
            };
          } catch (error) {
            return {
              title: "Free OpenCode models",
              output: error instanceof Error ? error.message : String(error),
            };
          }
        },
      }),
    },
  };
};

/** V2 reads `id` + `setup`; V1 1.18.29+ reads `server()`. Named export keeps older V1 loaders. */
export default {
  id: PROVIDER_ID,
  setup: setupOpenCodeV2,
  server: FreeOpenCodePlugin,
};
