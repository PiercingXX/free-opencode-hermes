/**
 * `free-opencode update` — pull the repo, rebuild, re-wire host files, restart.
 *
 * Sequence (each step is guarded):
 *   1. Resolve the repo root (FREE_OPENCODE_REPO / xx-stack + package.json).
 *   2. `git pull --ff-only` — fails clearly if the tree is dirty or not a checkout.
 *   3. `npm ci` when a lockfile is present (else `npm install`), then build the
 *      workspaces the installers already build (xx-stack/mcp-server, plugin).
 *   4. Re-run `node scripts/host-setup.mjs opencode-host` so the plugin URL, the
 *      MCP command, and the CLI wrappers point at this checkout. host-setup
 *      replaces any old packages/plugin/src/index.ts plugin entry.
 *   5. Restart the proxy (stop then start; the installed service is restarted).
 *
 * It never force-pushes and never `git reset --hard`. The default is strictly
 * ff-only pull.
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

function run(cwd: string, cmd: string, args: string[], capture = false): string {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
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

function gitHead(root: string): string {
  try {
    return run(root, "git", ["rev-parse", "--short", "HEAD"], true);
  } catch {
    return "unknown";
  }
}

function isGitClean(root: string): boolean {
  try {
    return !run(root, "git", ["status", "--porcelain"], true).trim();
  } catch {
    return true;
  }
}

function cliPath(): string {
  return join(repoRoot(), "packages", "plugin", "dist", "cli.js");
}

function runCli(args: string[]): void {
  const result = spawnSync(nodeExecutable(), [cliPath(), ...args], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`free-opencode ${args.join(" ")} failed: ${result.error.message}`);
  }
}

export async function cmdUpdate(): Promise<UpdateResult> {
  const root = repoRoot();
  const steps: string[] = [];
  const errors: string[] = [];
  const before = gitHead(root);
  void appendLog("update.step", { step: "begin", before, root });

  try {
    if (!existsSync(join(root, ".git"))) {
      throw new Error("not a git checkout — update only works in the cloned repository");
    }
    if (!isGitClean(root)) {
      throw new Error(
        "the repository has uncommitted changes; stash or commit them first (update does not clobber a dirty tree)"
      );
    }

    const pull = spawnSync("git", ["pull", "--ff-only"], { cwd: root, stdio: "inherit" });
    if (pull.status !== 0) {
      throw new Error("git pull --ff-only failed — resolve it, then re-run free-opencode update");
    }
    steps.push(`git pull --ff-only (${before} → ${gitHead(root)})`);
    void appendLog("update.step", { step: "pull", before, after: gitHead(root) });

    const lockfile = existsSync(join(root, "package-lock.json"));
    run(root, "npm", lockfile ? ["ci"] : ["install"]);
    steps.push(lockfile ? "npm ci" : "npm install");
    void appendLog("update.step", { step: "install", lockfile });

    run(join(root, "xx-stack", "mcp-server"), "npm", ["run", "build"]);
    steps.push("built xx-stack/mcp-server");

    run(root, "npm", ["run", "build", "-w", "free-opencode"]);
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
    return { before, after: before, changed: false, steps, errors };
  }
}
