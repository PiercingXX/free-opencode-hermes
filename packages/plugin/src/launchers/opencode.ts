import { join } from "node:path";

import { writeFileAtomic } from "../fs-atomic.js";
import { fccStyleAgentOverlay, stripNativePrimaryAgentFiles } from "../plugin/config.js";
import { OPENCODE_MIN_VERSION } from "../paths.js";
import {
  binaryVersion,
  formatVersion,
  orExit,
  privateTempDir,
  requireRunningProxy,
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

  const proxy = await requireRunningProxy();
  const config = await orExit("Could not prepare the OpenCode model catalog", async () => {
    const models = await fetchClientModels(proxy.url, proxy.token);
    const built = buildOpenCodeConfig(models, proxy.url);
    built.overlay.agent = fccStyleAgentOverlay();
    built.overlay.permission = { bash: "allow", edit: "allow" };
    return built;
  });

  const configPath = join(privateTempDir("foc-opencode-"), "opencode.json");
  // Holds only an {env:…} key reference today, but keep it private regardless.
  writeFileAtomic(configPath, `${JSON.stringify(config.file, null, 2)}\n`, 0o600);

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
