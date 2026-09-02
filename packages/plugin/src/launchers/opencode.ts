import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fccStyleAgentOverlay, stripNativePrimaryAgentFiles } from "../plugin/config.js";
import { ensureProxyRunning } from "../plugin/lifecycle.js";
import { OPENCODE_MIN_VERSION } from "../paths.js";
import {
  binaryVersion,
  formatVersion,
  resolveClientBinary,
  runClientProcess,
  versionAtLeast,
} from "./common.js";
import { fetchClientModels } from "./client-models.js";
import { buildOpenCodeConfig, buildOpenCodeLauncherEnv } from "./opencode-config.js";

const BINARY_NAME = "opencode";
const DISPLAY_NAME = "OpenCode CLI";
const INSTALL_HINT = "Install OpenCode from: https://opencode.ai/docs/";
const VERSION_PATTERN =
  /(?:(?:opencode(?:\s+version)?\s+)|v)?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?/m;
const PASSTHROUGH_COMMANDS = new Set(["auth", "upgrade", "uninstall", "completion"]);
const PASSTHROUGH_FLAGS = new Set(["--help", "-h", "--version", "-v"]);

export function isOpenCodePassthrough(argv: string[]): boolean {
  return Boolean(
    argv[0] && (PASSTHROUGH_COMMANDS.has(argv[0]) || argv.some((arg) => PASSTHROUGH_FLAGS.has(arg)))
  );
}

export function opencodeBinaryVersion(binaryPath: string): [number, number, number] | null {
  return binaryVersion(binaryPath, VERSION_PATTERN);
}

function requireCompatibleOpenCode(binaryPath: string): void {
  const version = opencodeBinaryVersion(binaryPath);
  if (versionAtLeast(version, OPENCODE_MIN_VERSION)) return;
  const minimum = formatVersion(OPENCODE_MIN_VERSION);
  console.error(
    `The OpenCode CLI at ${binaryPath} must be a stable release at least version ${minimum}.`
  );
  console.error("Upgrade it with: opencode upgrade");
  process.exit(126);
}

function rejectProcessConfigConflicts(env: NodeJS.ProcessEnv): void {
  for (const key of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT"]) {
    if (env[key]?.trim()) {
      console.error(
        `${key} is already set. Unset it before running foc-opencode; ordinary opencode remains unchanged.`
      );
      process.exit(1);
    }
  }
}

export async function launchOpenCode(argv: string[]): Promise<never> {
  const binaryPath = resolveClientBinary(BINARY_NAME, DISPLAY_NAME, INSTALL_HINT);
  if (isOpenCodePassthrough(argv)) {
    return runClientProcess([binaryPath, ...argv], process.env);
  }
  requireCompatibleOpenCode(binaryPath);
  rejectProcessConfigConflicts(process.env);
  const stripped = stripNativePrimaryAgentFiles();
  if (stripped.length > 0) {
    console.error(
      `Removed leftover agent files that replace OpenCode's native tools: ${stripped.join(", ")}`
    );
  }

  let proxy;
  try {
    proxy = await ensureProxyRunning();
  } catch (error) {
    console.error(
      `Free OpenCode proxy is not reachable: ${error instanceof Error ? error.message : String(error)}`
    );
    console.error("Start it with: free-opencode start");
    process.exit(1);
  }

  let config;
  try {
    const models = await fetchClientModels(proxy.url, proxy.token);
    config = buildOpenCodeConfig(models, proxy.url);
    config.overlay.agent = fccStyleAgentOverlay();
    config.overlay.permission = { bash: "allow", edit: "allow" };
  } catch (error) {
    console.error(
      `Could not prepare the OpenCode model catalog: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }

  const tempDirectory = mkdtempSync(join(tmpdir(), "foc-opencode-"));
  const cleanup = (): void => {
    try {
      rmSync(tempDirectory, { recursive: true, force: true });
    } catch {
      // best effort
    }
  };
  process.on("exit", cleanup);
  mkdirSync(tempDirectory, { recursive: true });
  const configPath = join(tempDirectory, "opencode.json");
  writeFileSync(configPath, `${JSON.stringify(config.file, null, 2)}\n`, "utf8");

  return runClientProcess(
    [binaryPath, ...argv],
    buildOpenCodeLauncherEnv(process.env, {
      proxyRootUrl: proxy.url,
      authToken: proxy.token,
      configPath,
      overlay: config.overlay,
    })
  );
}
