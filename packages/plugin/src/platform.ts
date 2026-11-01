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

/** True when `pid` names a live process (EPERM still means it exists). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Best-effort command line of `pid`, or null when it cannot be read. POSIX uses
 * `ps`; Windows asks CIM via PowerShell and falls back to wmic.
 */
export function processCommandLine(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const read = (cmd: string, args: string[]): string | null => {
    const result = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 5000 });
    if (result.error || result.status !== 0) return null;
    const out = (result.stdout || "").trim();
    return out || null;
  };
  if (!isWindows()) return read("ps", ["-o", "command=", "-p", String(pid)]);
  const viaCim = read("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
  ]);
  if (viaCim) return viaCim;
  const viaWmic = read("wmic", [
    "process",
    "where",
    `processid=${pid}`,
    "get",
    "commandline",
    "/value",
  ]);
  return viaWmic ? viaWmic.replace(/^CommandLine=/im, "").trim() || null : null;
}

/** A dedicated Free OpenCode proxy runs `node …/cli.js start --foreground`. */
export function looksLikeProxyCommand(commandLine: string | null): boolean {
  if (!commandLine) return false;
  return (
    /cli\.(c?js|mjs|ts)\b/.test(commandLine) &&
    /\bstart\b/.test(commandLine) &&
    /--foreground\b/.test(commandLine)
  );
}

/**
 * Terminate `pid` (SIGTERM, then SIGKILL; taskkill /F on Windows). Callers must
 * verify ownership first — see stopDetachedProxy. Never kills this process, and
 * never the whole tree, so a mis-recorded pid cannot take a host session with it.
 */
export function killPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  if (isWindows()) {
    spawnSync("taskkill", ["/PID", String(pid), "/F"], {
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
