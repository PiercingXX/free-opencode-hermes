import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export function isWindows(): boolean {
  return process.platform === "win32";
}

/** Absolute path -> file:// URL that OpenCode (and browsers) accept on Windows and Unix. */
export function fileUrlFromPath(filePath: string): string {
  return pathToFileURL(filePath).href;
}

export function opencodeConfigDir(home?: string): string {
  if (home) return join(home, ".config", "opencode");
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return join(xdg, "opencode");
  return join(homedir(), ".config", "opencode");
}

export function userBinDir(home = homedir()): string {
  return join(home, ".local", "bin");
}

export function looksLikeNodeBinary(execPath: string): boolean {
  const name = basename(execPath).toLowerCase();
  return name === "node" || name === "node.exe";
}

/**
 * Real Node binary for child processes. Inside OpenCode, process.execPath is
 * the OpenCode bun binary — using it as MCP `command[0]` makes OpenCode spawn
 * itself (`opencode dist/index.js`) and the MCP client sees -32000 connection closed.
 */
export function nodeExecutable(): string {
  if (looksLikeNodeBinary(process.execPath)) return process.execPath;
  const fromNpm = process.env.npm_node_execpath?.trim();
  if (fromNpm && existsSync(fromNpm) && looksLikeNodeBinary(fromNpm)) return fromNpm;
  const probe = spawnSync(isWindows() ? "where" : "which", ["node"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const found = (probe.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && existsSync(line) && looksLikeNodeBinary(line));
  if (found) return found;
  for (const candidate of ["/usr/bin/node", "/usr/local/bin/node"]) {
    if (existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

export function killPid(pid: number): void {
  if (pid <= 0) return;
  if (isWindows()) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}
