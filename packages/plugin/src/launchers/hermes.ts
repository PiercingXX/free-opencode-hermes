import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

import { ensureProxyRunning } from "../plugin/lifecycle.js";
import { HERMES_MIN_VERSION } from "../paths.js";
import {
  binaryVersion,
  formatVersion,
  resolveClientBinary,
  runClientProcess,
  versionAtLeast,
} from "./common.js";
import { fetchClientModels } from "./client-models.js";
import { buildHermesLauncherEnv, buildHermesManagedConfig } from "./hermes-config.js";

const BINARY_NAME = "hermes";
const DISPLAY_NAME = "Hermes Agent";
const INSTALL_URL = "https://hermes-agent.nousresearch.com/docs/installation";
const INSTALL_HINT = `Install Hermes Agent from: ${INSTALL_URL}`;
const VERSION_PATTERN = /(?:Hermes Agent\s+)?v?(\d+)\.(\d+)\.(\d+)/i;
const PASSTHROUGH_FLAGS = new Set(["-h", "--help", "-V", "--version"]);
const DETACHED_COMMANDS = new Set([
  "acp",
  "rl",
  "gateway",
  "cron",
  "serve",
  "dashboard",
  "gui",
  "desktop",
  "proxy",
]);
const GLOBAL_VALUE_OPTIONS = new Set([
  "-z",
  "--oneshot",
  "--usage-file",
  "-m",
  "--model",
  "--provider",
  "--reasoning",
  "-t",
  "--toolsets",
  "-r",
  "--resume",
  "--in",
  "-s",
  "--skills",
  "-p",
  "--profile",
]);
const GLOBAL_OPTIONAL_VALUE_OPTIONS = new Set(["-c", "--continue"]);
const GLOBAL_BOOLEAN_OPTIONS = new Set([
  "--no-restore-cwd",
  "-w",
  "--worktree",
  "--accept-hooks",
  "--yolo",
  "--pass-session-id",
  "--ignore-user-config",
  "--ignore-rules",
  "--safe-mode",
  "--tui",
  "--cli",
  "--dev",
]);

function beforeSeparator(argv: string[]): string[] {
  const index = argv.indexOf("--");
  return index >= 0 ? argv.slice(0, index) : argv;
}

function isJoinedGlobalValue(argument: string): boolean {
  for (const option of GLOBAL_VALUE_OPTIONS) {
    if (option.startsWith("--") && argument.startsWith(`${option}=`)) return true;
    if (
      option.startsWith("-") &&
      !option.startsWith("--") &&
      argument.startsWith(option) &&
      argument.length > option.length
    ) {
      return true;
    }
  }
  return false;
}

function nextRootIndex(argv: string[], index: number): number {
  const argument = argv[index];
  if (GLOBAL_VALUE_OPTIONS.has(argument)) return Math.min(index + 2, argv.length);
  if (
    GLOBAL_OPTIONAL_VALUE_OPTIONS.has(argument) &&
    index + 1 < argv.length &&
    !argv[index + 1].startsWith("-")
  ) {
    return index + 2;
  }
  return index + 1;
}

function rootPositionals(argv: string[], limit: number): string[] {
  const before = beforeSeparator(argv);
  const positionals: string[] = [];
  let index = 0;
  while (index < before.length && positionals.length < limit) {
    const argument = before[index];
    if (GLOBAL_VALUE_OPTIONS.has(argument)) {
      index += 2;
      continue;
    }
    if (isJoinedGlobalValue(argument)) {
      index += 1;
      continue;
    }
    if (GLOBAL_OPTIONAL_VALUE_OPTIONS.has(argument)) {
      if (index + 1 < before.length && !before[index + 1].startsWith("-")) index += 2;
      else index += 1;
      continue;
    }
    if (GLOBAL_BOOLEAN_OPTIONS.has(argument) || PASSTHROUGH_FLAGS.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      index += 1;
      continue;
    }
    positionals.push(argument);
    index += 1;
  }
  return positionals;
}

export function firstRootPositional(argv: string[]): string | undefined {
  return rootPositionals(argv, 1)[0];
}

export function detachedHermesSurface(argv: string[]): boolean {
  const root = firstRootPositional(argv);
  if (root && DETACHED_COMMANDS.has(root)) return true;
  return root === "mcp" && rootPositionals(argv, 2)[1] === "serve";
}

export function isHermesPassthrough(argv: string[]): boolean {
  const before = beforeSeparator(argv);
  if (before.some((argument) => PASSTHROUGH_FLAGS.has(argument))) return true;
  const root = firstRootPositional(argv);
  return root != null && root !== "chat" && !detachedHermesSurface(argv);
}

export function hermesProfileArgs(argv: string[]): string[] {
  const before = beforeSeparator(argv);
  let index = 0;
  while (index < before.length) {
    const argument = before[index];
    if (argument === "-p" || argument === "--profile") {
      if (index + 1 < before.length) return [argument, before[index + 1]];
      return [];
    }
    if (argument.startsWith("--profile=")) return [argument];
    index = nextRootIndex(before, index);
  }
  return [];
}

export function withoutRoutingOverrides(argv: string[]): {
  args: string[];
  selectedModel: string | null;
} {
  const cleaned: string[] = [];
  let selectedModel: string | null = null;
  let index = 0;
  while (index < argv.length) {
    const argument = argv[index];
    if (argument === "--") {
      cleaned.push(...argv.slice(index));
      break;
    }
    if (argument === "--provider" || argument.startsWith("--provider=")) {
      console.error(
        "foc-hermes owns the Hermes provider. Use ordinary hermes for a different provider."
      );
      process.exit(2);
    }
    if (argument === "-m" || argument === "--model") {
      if (index + 1 >= argv.length || argv[index + 1] === "--") {
        console.error("foc-hermes requires a value after --model/-m.");
        process.exit(2);
      }
      if (selectedModel != null) {
        console.error("foc-hermes accepts only one --model/-m override.");
        process.exit(2);
      }
      selectedModel = argv[index + 1];
      index += 2;
      continue;
    }
    if (argument.startsWith("--model=")) {
      const value = argument.slice("--model=".length);
      if (!value) {
        console.error("foc-hermes requires a value after --model/-m.");
        process.exit(2);
      }
      if (selectedModel != null) {
        console.error("foc-hermes accepts only one --model/-m override.");
        process.exit(2);
      }
      selectedModel = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("-m") && argument.length > 2) {
      if (selectedModel != null) {
        console.error("foc-hermes accepts only one --model/-m override.");
        process.exit(2);
      }
      selectedModel = argument.slice(2);
      index += 1;
      continue;
    }
    cleaned.push(argument);
    index += 1;
  }
  return { args: cleaned, selectedModel };
}

export function hermesBinaryVersion(binaryPath: string): [number, number, number] | null {
  return binaryVersion(binaryPath, VERSION_PATTERN);
}

function requireCompatibleHermes(binaryPath: string): void {
  const version = hermesBinaryVersion(binaryPath);
  if (versionAtLeast(version, HERMES_MIN_VERSION)) return;
  console.error(
    `The Hermes Agent at ${binaryPath} must be at least version ${formatVersion(HERMES_MIN_VERSION)}.`
  );
  console.error(`Upgrade it from: ${INSTALL_URL}`);
  process.exit(126);
}

function rejectManagedPolicy(env: NodeJS.ProcessEnv): void {
  if (
    env.HERMES_MANAGED_DIR?.trim() ||
    (process.platform !== "win32" && existsSync("/etc/hermes"))
  ) {
    console.error(
      "foc-hermes will not replace an existing Hermes managed policy. Use ordinary hermes or remove the administrator-managed scope."
    );
    process.exit(2);
  }
}

function writePrivateJson(path: string, payload: Record<string, unknown>): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
}

function requireOverlayActivation(
  binaryPath: string,
  profileArgs: string[],
  expectedProvider: string,
  env: NodeJS.ProcessEnv
): void {
  const result = spawnSync(
    binaryPath,
    [...profileArgs, "config", "get", "model.provider", "--json"],
    {
      encoding: "utf8",
      timeout: 15000,
      env,
      windowsHide: true,
    }
  );
  if (result.status !== 0) {
    overlayActivationError();
  }
  const lines = (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) overlayActivationError();
  try {
    const active = JSON.parse(lines[lines.length - 1]);
    if (active !== expectedProvider) overlayActivationError();
  } catch {
    overlayActivationError();
  }
}

function overlayActivationError(): never {
  console.error(
    "Hermes did not honor the temporary Free OpenCode route. Check the selected Hermes profile and managed-policy settings."
  );
  process.exit(1);
}

export async function launchHermes(argv: string[]): Promise<never> {
  const binaryPath = resolveClientBinary(BINARY_NAME, DISPLAY_NAME, INSTALL_HINT);
  if (isHermesPassthrough(argv)) {
    return runClientProcess([binaryPath, ...argv], process.env);
  }
  if (detachedHermesSurface(argv)) {
    console.error(
      "foc-hermes supports attached terminal sessions only. Run this detached Hermes surface with ordinary hermes instead."
    );
    process.exit(2);
  }

  const profileArgs = hermesProfileArgs(argv);
  const { args, selectedModel } = withoutRoutingOverrides(argv);
  rejectManagedPolicy(process.env);
  requireCompatibleHermes(binaryPath);

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

  let managed;
  try {
    const models = await fetchClientModels(proxy.url, proxy.token);
    managed = buildHermesManagedConfig(models, {
      proxyRootUrl: proxy.url,
      nonce: randomBytes(8).toString("hex"),
      selectedModel,
    });
  } catch (error) {
    console.error(
      `Could not prepare the Hermes model catalog: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }

  const tempDirectory = mkdtempSync(join(tmpdir(), "foc-hermes-"));
  const cleanup = (): void => {
    try {
      rmSync(tempDirectory, { recursive: true, force: true });
    } catch {
      // best effort
    }
  };
  process.on("exit", cleanup);
  mkdirSync(tempDirectory, { recursive: true });
  if (process.platform !== "win32") {
    try {
      chmodSync(tempDirectory, 0o700);
    } catch {
      // ignore
    }
  }
  writePrivateJson(join(tempDirectory, "config.yaml"), managed.config);

  const childEnv = buildHermesLauncherEnv(process.env, {
    managedDirectory: tempDirectory,
    keyEnv: managed.keyEnv,
    authToken: proxy.token,
  });
  requireOverlayActivation(binaryPath, profileArgs, managed.providerRef, childEnv);
  return runClientProcess(
    [binaryPath, "--provider", managed.providerRef, "--model", managed.selectedModel, ...args],
    childEnv
  );
}
