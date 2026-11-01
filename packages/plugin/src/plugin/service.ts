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

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { writeFileAtomic } from "../fs-atomic.js";
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

/**
 * Run a service-manager command and throw (with its stderr) when it fails to
 * spawn *or* exits non-zero — a non-zero systemctl/launchctl is not success.
 */
function runChecked(cmd: string, args: string[], label = `${cmd} ${args.join(" ")}`): void {
  const result = __serviceRuntime.spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error) throw new Error(`${label} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail =
      `${result.stderr ?? ""}`.trim() || `${result.stdout ?? ""}`.trim() || `exit ${result.status}`;
    throw new Error(`${label} failed: ${detail}`);
  }
}

function guiDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
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
      __serviceRuntime.execFileSync("launchctl", ["bootout", guiDomain(), MAC_LABEL], {
        stdio: "ignore",
      });
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
  writeFileAtomic(systemdUnitPath(), systemdUnitBody(), 0o644);
  runChecked("systemctl", ["--user", "daemon-reload"]);
  runChecked("systemctl", ["--user", "enable", "--now", SERVICE_NAME]);
  // Best-effort: keep the user unit alive after logout. Never requires root; a
  // headless box without linger drops a user service at logout, which a Proxy
  // user service should survive. Failure is informational only.
  __serviceRuntime.spawnSync(
    "loginctl",
    ["enable-linger", process.env.USER ?? homeDir().split("/").pop() ?? ""],
    { stdio: "ignore", windowsHide: true }
  );
}

function installLaunchAgent(): void {
  writeFileAtomic(launchAgentPath(), launchAgentBody(), 0o644);
  // Unload any previous copy; failure just means it was not loaded.
  __serviceRuntime.spawnSync("launchctl", ["bootout", guiDomain(), MAC_LABEL], { stdio: "ignore" });
  runChecked("launchctl", ["bootstrap", guiDomain(), launchAgentPath()], "launchctl bootstrap");
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
  const [exe, script, ...rest] = execArgs();
  const command = existsSync(wrapper)
    ? `${quoteForCmd(wrapper)} start --foreground`
    : `${quoteForCmd(exe)} ${quoteForCmd(script)} ${rest.join(" ")}`;
  const body = `@echo off\r\n${command}\r\n`;
  writeFileAtomic(scriptPath, body, 0o644);
  return scriptPath;
}

function installScheduledTask(): void {
  // Per-user logon scheduled task (never SYSTEM). Runs the CLI in the
  // foreground; the proxy keeps :8082 up for that user.
  const scriptPath = writeWindowsTaskScript();
  // One path token only — spaces get a single pair of quotes, no nesting.
  const tr = /\s/.test(scriptPath) ? `"${scriptPath}"` : scriptPath;
  runChecked(
    "schtasks",
    ["/Create", "/TN", SERVICE_NAME, "/SC", "ONLOGON", "/RL", "LIMITED", "/F", "/TR", tr],
    "schtasks /Create"
  );
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
    let running: boolean;
    try {
      const result = __serviceRuntime.execFileSync(
        "launchctl",
        ["print", `${guiDomain()}/${MAC_LABEL}`],
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
    let running: boolean;
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
    runChecked("schtasks", ["/Run", "/TN", SERVICE_NAME], "schtasks /Run");
  } else if (isMac()) {
    runChecked(
      "launchctl",
      ["kickstart", "-k", `${guiDomain()}/${MAC_LABEL}`],
      "launchctl kickstart"
    );
  } else if (isLinux()) {
    runChecked("systemctl", ["--user", "restart", SERVICE_NAME], "systemctl restart");
  }
}
