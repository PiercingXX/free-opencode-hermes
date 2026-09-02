import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

import { applyEnvOverrides, loadSettings, readyProviderIds } from "./config/settings.js";
import { OPENCODE_LAUNCHER_TOKEN_ENV, PROVIDER_ID, TOKEN_ENV } from "./paths.js";
import { buildAuthHook } from "./plugin/auth.js";
import { injectOpenCodeConfig } from "./plugin/config.js";
import {
  ensureProxyInProcess,
  exportProxyToken,
  proxyUrlFromSettings,
} from "./plugin/lifecycle.js";
import { buildModelCatalog, defaultListedModels } from "./proxy/models.js";

export const FreeOpenCodePlugin: Plugin = async () => {
  exportProxyToken();
  try {
    await ensureProxyInProcess();
  } catch {
    // OpenCode still loads; Admin/CLI can start the proxy later.
  }

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
          "Show Free OpenCode proxy status, ready providers, and default model. No required arguments; call with {}.",
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
            const body: Record<string, unknown> = {
              provider: PROVIDER_ID,
              url: proxyUrlFromSettings(),
              defaultModel: settings.model,
              readyProviders: ready,
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
          "List models currently routed through the Free OpenCode proxy. No required arguments; call with {}.",
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
            const lines =
              models.map((m) => m.id).join("\n") || "No models yet. Connect a provider.";
            return { title: "Free OpenCode models", output: lines };
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
