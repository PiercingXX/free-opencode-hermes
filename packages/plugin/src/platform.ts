import { homedir } from "node:os";
import { join } from "node:path";
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

export function nodeExecutable(): string {
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
