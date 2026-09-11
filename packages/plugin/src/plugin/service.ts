/**
 * Keep-alive service for the Free OpenCode proxy.
 *
 * `free-opencode start` detaches a Node process that dies on reboot and on a
 * crashed terminal. This module installs a user-level keep-alive that runs
 * `node …/packages/plugin/dist/cli.js start --foreground` so :8082 survives
 * logins. No root required.
 *
 *   Linux/macOS   systemd user unit / launchd user agent
 *   Windows       a per-user logon scheduled task (never SYSTEM)
 *
 * Linux/macOS restart a crashed proxy (Restart=on-failure / KeepAlive) but not
 * a clean stop: the CLI stop path exits 0, so the unit/plist do not bounce it
 * back up. The Windows scheduled task is ONLOGON only — it does NOT restart after
 * a crash (a restart-on-crash requires a SYSTEM task, which we deliberately do
 * not create). See MANUAL §13.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { repoRoot } from "../paths.js";
import { nodeExecutable, userBinDir } from "../platform.js";
import { appendLog } from "../proxy/route-log.js";

const SERVICE_NAME = "free-opencode-proxy";
const MAC_LABEL = "com.free-opencode.proxy";

// --- test seams -----------------------------------------------------------
// The installers are IO: they target $HOME per-platform files and shell out to
// systemctl / launchctl / schtasks. Tests override home + platform and stub the
// child-process calls so a unit/plist/task can be asserted without any real
// system service being touched (no real schtasks / systemctl in CI).
let testHome: string | null = null;
export function __setTestHome(home: string | null): void {
  testHome = home;
}
function homeDir(): string {
  return testHome ?? homedir();
}

let testPlatform: NodeJS.Platform | null = null;
export function __setTestPlatform(platform: NodeJS.Platform | null): void {
  testPlatform = platform;
}
function currentPlatform(): NodeJS.Platform {
  return testPlatform ?? process.platform;
}

export type ExecCall = { cmd: string; args: string[] };
export const __serviceRuntime: {
  spawnSync: (
    cmd: string,
    args: string[],
    opts?: Record<string, unknown>
  ) => {
    status: number | null;
    error?: Error | null;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
  };
  execFileSync: (cmd: string, args: string[], opts?: Record<string, unknown>) => unknown;
} = {
  spawnSync: (cmd, args, opts) => spawnSync(cmd, args as string[], opts as never),
  execFileSync: (cmd, args, opts) => execFileSync(cmd, args as string[], opts as never) as unknown,
};
/** Tests replace these with recorders so no real system service is touched. */
export function __setSpawnSync(fn: typeof __serviceRuntime.spawnSync | null): void {
  __serviceRuntime.spawnSync =
    fn ??
    ((cmd, args, opts): ReturnType<typeof __serviceRuntime.spawnSync> =>
      spawnSync(cmd, args as string[], opts as never));
}
export function __setExecFileSync(fn: typeof __serviceRuntime.execFileSync | null): void {
  __serviceRuntime.execFileSync =
    fn ??
    ((cmd, args, opts): ReturnType<typeof __serviceRuntime.execFileSync> =>
      execFileSync(cmd, args as string[], opts as never) as unknown);
}

function cliPath(): string {
  return join(repoRoot(), "packages", "plugin", "dist", "cli.js");
}

/** The exact argv the keep-alive runs, in order. */
function execArgs(): string[] {
  return [nodeExecutable(), cliPath(), "start", "--foreground"];
}

function serviceDir(home = homeDir()): string {
  return join(home, ".config", "free-opencode");
}

function isMac(): boolean {
  return currentPlatform() === "darwin";
}

function isLinux(): boolean {
  return currentPlatform() === "linux";
}

function isWindows(): boolean {
  return currentPlatform() === "win32";
}

function systemdUserDir(home = homeDir()): string {
  return join(home, ".config", "systemd", "user");
}

function systemdUnitPath(home = homeDir()): string {
  return join(systemdUserDir(home), `${SERVICE_NAME}.service`);
}

function systemdUnitBody(): string {
  const [cmd, script, ...rest] = execArgs();
  const args = [script, ...rest].join(" ");
  return `[Unit]
Description=Free OpenCode proxy (:8082 local model gateway)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${cmd} ${args}
Restart=on-failure
RestartSec=2
Environment=NO_PROXY=127.0.0.1,localhost

[Install]
WantedBy=default.target
`;
}

function launchAgentPath(home = homeDir()): string {
  return join(home, "Library", "LaunchAgents", `${MAC_LABEL}.plist`);
}

function launchAgentBody(): string {
  const args = execArgs()
    .map((a) => `    <string>${a.replace(/&/g, "&amp;")}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${join(homeDir(), ".free-opencode", "launchd.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(homeDir(), ".free-opencode", "launchd.log")}</string>
</dict>
</plist>
`;
}

export type ServiceStatus = {
  installed: boolean;
  running: boolean;
  source: "systemd" | "launchd" | "scheduled-task" | "unknown";
  detail?: string;
};

export function serviceInstall(): void {
  mkdirSync(serviceDir(), { recursive: true, mode: 0o700 });
  if (isWindows()) {
    installScheduledTask();
  } else if (isMac()) {
    installLaunchAgent();
  } else if (isLinux()) {
    installSystemdUnit();
  } else {
    throw new Error(`unsupported platform for keep-alive service: ${process.platform}`);
  }
  void appendLog("service.install", { platform: currentPlatform(), command: cliPath() });
}

export function serviceUninstall(): void {
  if (isWindows()) {
    try {
      __serviceRuntime.execFileSync("schtasks", ["/Delete", "/TN", SERVICE_NAME, "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // not installed
    }
    removeIfExists(windowsTaskScriptPath());
  } else if (isMac()) {
    try {
      __serviceRuntime.execFileSync(
        "launchctl",
        ["bootout", `gui/${process.getuid?.() ?? 501}`, MAC_LABEL],
        { stdio: "ignore" }
      );
    } catch {
      // not loaded
    }
    removeIfExists(launchAgentPath());
  } else if (isLinux()) {
    try {
      __serviceRuntime.execFileSync("systemctl", ["--user", "disable", "--now", SERVICE_NAME], {
        stdio: "ignore",
      });
    } catch {
      // not enabled
    }
    removeIfExists(systemdUnitPath());
  }
  void appendLog("service.uninstall", { platform: currentPlatform() });
}

function removeIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone or not writable
  }
}

function installSystemdUnit(): void {
  const dir = systemdUserDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(systemdUnitPath(), systemdUnitBody(), "utf8");
  for (const args of [
    ["--user", "daemon-reload"],
    ["--user", "enable", "--now", SERVICE_NAME],
  ]) {
    const result = __serviceRuntime.spawnSync("systemctl", args, {
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) {
      throw new Error(`systemctl ${args[1]} failed: ${result.error.message}`);
    }
  }
  // Best-effort: keep the user unit alive after logout. Never requires root; a
  // headless box without linger drops a user service at logout, which a Proxy
  // user service should survive. Failure is informational only.
  try {
    __serviceRuntime.spawnSync(
      "loginctl",
      ["enable-linger", process.env.USER ?? homeDir().split("/").pop() ?? ""],
      { stdio: "ignore", windowsHide: true }
    );
  } catch {
    // linger unavailable — the unit still works while logged in
  }
}

function installLaunchAgent(): void {
  const dir = join(homeDir(), "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(launchAgentPath(), launchAgentBody(), "utf8");
  __serviceRuntime.spawnSync(
    "launchctl",
    ["bootout", `gui/${process.getuid?.() ?? 501}`, MAC_LABEL],
    { stdio: "ignore" }
  );
  const result = __serviceRuntime.spawnSync(
    "launchctl",
    ["bootstrap", `gui/${process.getuid?.() ?? 501}`, launchAgentPath()],
    { stdio: "ignore" }
  );
  if (result.error) {
    throw new Error(`launchctl bootstrap failed: ${result.error.message}`);
  }
}

/** Quote a path for a .cmd file (cmd.exe doubles embedded quotes). */
function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * schtasks /TR cannot reliably parse nested quotes around node.exe + cli.js
 * (ERROR: "The task XML contains a value which is incorrectly formatted…").
 * Point /TR at a single helper .cmd with no further args instead.
 */
export function windowsTaskScriptPath(home = homeDir()): string {
  return join(serviceDir(home), "start-proxy.cmd");
}

export function writeWindowsTaskScript(home = homeDir()): string {
  mkdirSync(serviceDir(home), { recursive: true, mode: 0o700 });
  const scriptPath = windowsTaskScriptPath(home);
  const wrapper = join(userBinDir(home), "free-opencode.cmd");
  const body = existsSync(wrapper)
    ? `@echo off\r\n${quoteForCmd(wrapper)} start --foreground\r\n`
    : (() => {
        const [exe, script, ...rest] = execArgs();
        return `@echo off\r\n${quoteForCmd(exe)} ${quoteForCmd(script)} ${rest.join(" ")}\r\n`;
      })();
  writeFileSync(scriptPath, body, "utf8");
  return scriptPath;
}

function installScheduledTask(): void {
  // Per-user logon scheduled task (never SYSTEM). Runs the CLI in the
  // foreground; the proxy keeps :8082 up for that user.
  const scriptPath = writeWindowsTaskScript();
  // One path token only — spaces get a single pair of quotes, no nesting.
  const tr = /\s/.test(scriptPath) ? `"${scriptPath}"` : scriptPath;
  const result = __serviceRuntime.spawnSync(
    "schtasks",
    ["/Create", "/TN", SERVICE_NAME, "/SC", "ONLOGON", "/RL", "LIMITED", "/F", "/TR", tr],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.error) {
    throw new Error(`schtasks /Create failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim() || `exit ${result.status}`;
    throw new Error(`schtasks /Create failed: ${detail}`);
  }
}

export function serviceStatus(): ServiceStatus {
  if (isWindows()) {
    const result = __serviceRuntime.spawnSync("schtasks", ["/Query", "/TN", SERVICE_NAME], {
      encoding: "utf8",
      windowsHide: true,
    });
    const installed =
      result.status === 0 && `${result.stdout ?? ""}${result.stderr ?? ""}`.includes(SERVICE_NAME);
    return { installed, running: installed, source: "scheduled-task" };
  }
  if (isMac()) {
    const installed = existsSync(launchAgentPath());
    let running = false;
    try {
      const result = __serviceRuntime.execFileSync(
        "launchctl",
        ["print", `gui/${process.getuid?.() ?? 501}/${MAC_LABEL}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
      running = String(result).includes("state = running");
    } catch {
      running = false;
    }
    return { installed, running, source: "launchd" };
  }
  if (isLinux()) {
    const installed = existsSync(systemdUnitPath());
    let running = false;
    try {
      const result = __serviceRuntime.execFileSync(
        "systemctl",
        ["--user", "is-active", SERVICE_NAME],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
      running = String(result).trim() === "active";
    } catch {
      running = false;
    }
    return { installed, running, source: "systemd" };
  }
  return { installed: false, running: false, source: "unknown" };
}

/** Restart a service that is already installed (a no-op path for each OS). */
export function serviceRestart(): void {
  if (isWindows()) {
    const result = __serviceRuntime.spawnSync("schtasks", ["/Run", "/TN", SERVICE_NAME], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.error) throw new Error(`schtasks /Run failed: ${result.error.message}`);
    return;
  }
  if (isMac()) {
    const result = __serviceRuntime.spawnSync(
      "launchctl",
      ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${MAC_LABEL}`],
      { stdio: "ignore", windowsHide: true }
    );
    if (result.error) throw new Error(`launchctl kickstart failed: ${result.error.message}`);
    return;
  }
  if (isLinux()) {
    const result = __serviceRuntime.spawnSync("systemctl", ["--user", "restart", SERVICE_NAME], {
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw new Error(`systemctl restart failed: ${result.error.message}`);
  }
}
