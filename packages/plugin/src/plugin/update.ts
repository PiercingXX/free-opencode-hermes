/**
 * `free-opencode update` — pull the repo, rebuild, re-wire host files, restart.
 *
 * Sequence (each step is guarded):
 *   1. Resolve the repo root (FREE_OPENCODE_REPO / xx-stack + package.json).
 *   2. Preflight, before anything changes: a git checkout, a clean tree, on
 *      branch `main` tracking `<remote>/main`, and npm resolvable. A failure
 *      here leaves HEAD where it was.
 *   3. `git fetch`, print the commit range (old..new), then `git merge
 *      --ff-only` onto the upstream.
 *   4. `npm ci` when a lockfile is present (else `npm install`), then build the
 *      workspaces the installers already build (xx-stack/mcp-server, plugin).
 *   5. Re-run `node scripts/host-setup.mjs opencode-host` so the plugin URL, the
 *      MCP command, and the CLI wrappers point at this checkout.
 *   6. Restart the proxy (stop then start; the installed service is restarted).
 *
 * It never force-pushes and never `git reset --hard`; only fast-forwards.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../paths.js";
import { nodeExecutable } from "../platform.js";
import { serviceRestart, serviceStatus } from "./service.js";
import { appendLog } from "../proxy/route-log.js";

export type UpdateResult = {
  before: string;
  after: string;
  changed: boolean;
  steps: string[];
  errors: string[];
};

const UPDATE_BRANCH = "main";

type Command = { cmd: string; shell: boolean };

/**
 * npm is `npm.cmd` on Windows, which Node cannot spawn without a shell. The
 * shell is only used on win32 and only with this module's fixed literal args.
 */
export function npmCommand(platform: NodeJS.Platform = process.platform): Command {
  return platform === "win32" ? { cmd: "npm.cmd", shell: true } : { cmd: "npm", shell: false };
}

function run(cwd: string, command: Command | string, args: string[], capture = false): string {
  const { cmd, shell } = typeof command === "string" ? { cmd: command, shell: false } : command;
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
    shell,
  });
  if (result.error) {
    throw new Error(`${cmd} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const tail = capture ? `${result.stderr ?? ""}${result.stdout ?? ""}`.trim() : "";
    throw new Error(`${cmd} ${args.join(" ")} failed${tail ? `: ${tail}` : ""}`);
  }
  return `${result.stdout ?? ""}`.trim();
}

function git(root: string, args: string[]): string {
  return run(root, "git", args, true);
}

function gitHead(root: string): string {
  try {
    return git(root, ["rev-parse", "--short", "HEAD"]);
  } catch {
    return "unknown";
  }
}

/** Everything that can fail without side effects runs here, before any pull. */
function preflight(root: string): { upstream: string } {
  if (!existsSync(join(root, ".git"))) {
    throw new Error("not a git checkout — update only works in the cloned repository");
  }
  if (git(root, ["status", "--porcelain"])) {
    throw new Error(
      "the repository has uncommitted changes; stash or commit them first (update does not clobber a dirty tree)"
    );
  }
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== UPDATE_BRANCH) {
    throw new Error(`update only runs on branch '${UPDATE_BRANCH}' (currently on '${branch}')`);
  }
  let upstream: string;
  try {
    upstream = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  } catch {
    throw new Error(
      `branch '${UPDATE_BRANCH}' has no upstream; run: git branch --set-upstream-to=origin/${UPDATE_BRANCH}`
    );
  }
  if (!upstream.endsWith(`/${UPDATE_BRANCH}`)) {
    throw new Error(`'${UPDATE_BRANCH}' tracks '${upstream}', expected <remote>/${UPDATE_BRANCH}`);
  }
  try {
    run(root, npmCommand(), ["--version"], true);
  } catch (error) {
    throw new Error(
      `npm is not runnable (${error instanceof Error ? error.message : String(error)}); install Node.js/npm first`,
      { cause: error }
    );
  }
  return { upstream };
}

/** Progress output (the commit range) goes straight to the terminal. */
function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function cliPath(): string {
  return join(repoRoot(), "packages", "plugin", "dist", "cli.js");
}

function runCli(args: string[]): void {
  run(repoRoot(), nodeExecutable(), [cliPath(), ...args]);
}

export async function cmdUpdate(): Promise<UpdateResult> {
  const root = repoRoot();
  const steps: string[] = [];
  const errors: string[] = [];
  const before = gitHead(root);
  void appendLog("update.step", { step: "begin", before, root });

  try {
    const { upstream } = preflight(root);
    const npm = npmCommand();

    run(root, "git", ["fetch", "--quiet"]);
    const incoming = Number(git(root, ["rev-list", "--count", `HEAD..${upstream}`]));
    if (incoming > 0) {
      const target = git(root, ["rev-parse", "--short", upstream]);
      say(`Pulling ${upstream} ${before}..${target} (${incoming} commit(s)):`);
      say(git(root, ["log", "--oneline", "--no-decorate", `HEAD..${upstream}`]));
      run(root, "git", ["merge", "--ff-only", upstream]);
    } else {
      say(`${upstream} has no new commits.`);
    }
    steps.push(`git fast-forward ${upstream} (${before} → ${gitHead(root)})`);
    void appendLog("update.step", { step: "pull", before, after: gitHead(root) });

    const lockfile = existsSync(join(root, "package-lock.json"));
    run(root, npm, lockfile ? ["ci"] : ["install"]);
    steps.push(lockfile ? "npm ci" : "npm install");
    void appendLog("update.step", { step: "install", lockfile });

    run(join(root, "xx-stack", "mcp-server"), npm, ["run", "build"]);
    steps.push("built xx-stack/mcp-server");

    run(root, npm, ["run", "build", "-w", "free-opencode"]);
    steps.push("built free-opencode plugin");

    run(root, nodeExecutable(), [join(root, "scripts", "host-setup.mjs"), "opencode-host"]);
    steps.push("re-ran host-setup opencode-host");
    void appendLog("update.step", { step: "host-setup" });

    // Stop the running/old proxy first; the service restarts cleanly.
    runCli(["stop"]);
    const status = serviceStatus();
    if (status.installed) {
      serviceRestart();
      steps.push("restarted keep-alive service");
      void appendLog("update.step", { step: "service-restart", source: status.source });
    } else {
      runCli(["start"]);
      steps.push("restarted proxy (detached)");
    }

    const after = gitHead(root);
    steps.push(`HEAD: ${before} → ${after}`);
    return { before, after, changed: before !== after, steps, errors };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    void appendLog("update.error", { message, root });
    const after = gitHead(root);
    return { before, after, changed: before !== after, steps, errors };
  }
}
