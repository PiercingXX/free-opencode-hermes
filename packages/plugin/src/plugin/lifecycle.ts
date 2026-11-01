import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { applyEnvOverrides, loadSettings, type Settings } from "../config/settings.js";
import { writeFileAtomic } from "../fs-atomic.js";
import { OPENCODE_LAUNCHER_TOKEN_ENV, TOKEN_ENV, pidPath } from "../paths.js";
import {
  isPidAlive,
  killPid,
  looksLikeProxyCommand,
  nodeExecutable,
  processCommandLine,
} from "../platform.js";
import { fetchProxyHealth, isStaleProxy, startProxy, waitForListen } from "../proxy/server.js";

let running: Awaited<ReturnType<typeof startProxy>> | null = null;

export function proxyUrl(settings: Settings): string {
  return `http://${settings.listen.host}:${settings.listen.port}`;
}

export function proxyUrlFromSettings(): string {
  return proxyUrl(applyEnvOverrides(loadSettings()));
}

function cliEntry(): string {
  const arg = process.argv[1];
  if (arg && existsSync(arg) && /cli\.(c?js|mjs|ts)$/.test(arg)) return arg;
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
}

export function localCodeBuiltAt(): number {
  try {
    return statSync(cliEntry()).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Who owns the proxy pidfile. "detached" is a dedicated `cli.js start
 * --foreground` process (spawned detached, or run by the keep-alive service)
 * and may be stopped. "in-process" is a proxy embedded in a host (the OpenCode
 * plugin) — its pid is the host's, so it is recorded for diagnostics only and
 * is never killed. Legacy pidfiles held a bare number; they are read as
 * unverified detached records.
 */
export type PidRecord = {
  pid: number;
  kind: "detached" | "in-process";
  startedAt: number;
  port: number;
  legacy?: boolean;
};

export function parsePidRecord(raw: string): PidRecord | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const pid = Number(text);
    return pid > 0 ? { pid, kind: "detached", startedAt: 0, port: 0, legacy: true } : null;
  }
  try {
    const obj = JSON.parse(text) as Partial<PidRecord>;
    const pid = Number(obj.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (obj.kind !== "detached" && obj.kind !== "in-process") return null;
    return {
      pid,
      kind: obj.kind,
      startedAt: Number(obj.startedAt) || 0,
      port: Number(obj.port) || 0,
    };
  } catch {
    return null;
  }
}

export function readPidRecord(path = pidPath()): PidRecord | null {
  try {
    return parsePidRecord(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writePidRecord(
  record: Omit<PidRecord, "startedAt" | "legacy"> & { startedAt?: number },
  path = pidPath()
): void {
  const body: PidRecord = { startedAt: Date.now(), ...record };
  writeFileAtomic(path, `${JSON.stringify(body)}\n`);
}

function removePidFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/** Remove the pidfile on exit, but only if it still names this process. */
export function clearPidRecordOnExit(path = pidPath()): void {
  process.once("exit", () => {
    if (readPidRecord(path)?.pid === process.pid) removePidFile(path);
  });
}

export type PidfileState =
  | { state: "none" }
  | { state: "stale"; record: PidRecord | null; reason: string }
  | { state: "live"; record: PidRecord; killable: boolean; reason: string };

/** Test seam: process probes used to verify ownership of a recorded pid. */
export const __pidProbe = {
  isAlive: isPidAlive,
  commandLine: processCommandLine,
};

/**
 * Classify the pidfile without side effects (also used by `doctor`).
 * `healthPid` is the pid the proxy's /health reports on the configured port:
 * when known it is authoritative (match → killable, mismatch → not ours);
 * otherwise ownership falls back to the process command line.
 */
export function inspectPidfile(path = pidPath(), healthPid?: number): PidfileState {
  if (!existsSync(path)) return { state: "none" };
  const record = readPidRecord(path);
  if (!record) return { state: "stale", record: null, reason: "unreadable pidfile" };
  if (!__pidProbe.isAlive(record.pid)) {
    return { state: "stale", record, reason: `pid ${record.pid} is not running` };
  }
  if (record.kind === "in-process") {
    return {
      state: "live",
      record,
      killable: false,
      reason: `in-process proxy hosted by pid ${record.pid} (not stopped by the CLI)`,
    };
  }
  if (record.pid === process.pid) {
    return { state: "live", record, killable: false, reason: "this process" };
  }
  if (typeof healthPid === "number") {
    if (healthPid === record.pid) {
      return { state: "live", record, killable: true, reason: `detached proxy pid ${record.pid}` };
    }
    if (!looksLikeProxyCommand(__pidProbe.commandLine(record.pid))) {
      return {
        state: "stale",
        record,
        reason: `pid ${record.pid} is not the proxy on the port (pid ${healthPid}) nor a Free OpenCode proxy`,
      };
    }
    // A second proxy process that does not hold the port: still ours, killable.
  }
  // Pids are reused: only kill when the command line is still our proxy.
  if (!looksLikeProxyCommand(__pidProbe.commandLine(record.pid))) {
    return {
      state: "stale",
      record,
      reason: `pid ${record.pid} is running but is not a Free OpenCode proxy`,
    };
  }
  return { state: "live", record, killable: true, reason: `detached proxy pid ${record.pid}` };
}

export type StopResult = { stopped: boolean; pid?: number; reason: string };

/**
 * Stop the detached proxy named by the pidfile — only after verifying the pid
 * is still a dedicated proxy process. In-process (host-embedded) proxies are
 * never killed. Stale pidfiles are removed.
 */
export function stopDetachedProxy(path = pidPath(), healthPid?: number): StopResult {
  const status = inspectPidfile(path, healthPid);
  if (status.state === "none") return { stopped: false, reason: "no pidfile" };
  if (status.state === "stale") {
    removePidFile(path);
    return {
      stopped: false,
      pid: status.record?.pid,
      reason: `removed stale pidfile (${status.reason})`,
    };
  }
  if (!status.killable) return { stopped: false, pid: status.record.pid, reason: status.reason };
  killPid(status.record.pid);
  removePidFile(path);
  return { stopped: true, pid: status.record.pid, reason: status.reason };
}

export function spawnDetachedProxy(): number {
  const child = spawn(nodeExecutable(), [cliEntry(), "start", "--foreground"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  if (child.pid == null) {
    throw new Error("failed to spawn the Free OpenCode proxy");
  }
  return child.pid;
}

export async function waitUntilHealthy(url: string): Promise<boolean> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const health = await fetchProxyHealth(url);
    if (health?.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

/** stopDetachedProxy, first asking the proxy at `url` (if any) for its pid. */
export async function stopProxyAt(url: string, path = pidPath()): Promise<StopResult> {
  const health = await fetchProxyHealth(url);
  return stopDetachedProxy(path, health?.ok ? health.pid : undefined);
}

/** After stopping a proxy, wait (briefly) for its port to stop answering. */
export async function waitUntilDown(url: string, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await fetchProxyHealth(url))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** Stop a stale, verifiably-ours detached proxy; false when it must be left alone. */
export async function replaceStaleProxy(url: string): Promise<boolean> {
  if (!(await stopProxyAt(url)).stopped) return false;
  await waitUntilDown(url);
  return true;
}

export async function ensureProxyInProcess(): Promise<string> {
  const settings = applyEnvOverrides(loadSettings());
  const url = proxyUrl(settings);
  const health = await fetchProxyHealth(url);
  if (health?.ok && !isStaleProxy(health, localCodeBuiltAt())) return url;
  if (running) return running.url;
  if (health?.ok) {
    // A stale proxy holds the port. Replace it only if it is a detached proxy
    // we can verify; another host's in-process proxy keeps serving.
    if (!(await replaceStaleProxy(url))) return url;
  }
  running = startProxy(settings);
  await waitForListen(running);
  // Recorded for diagnostics only: this pid is the host (OpenCode) process.
  writePidRecord({ pid: process.pid, kind: "in-process", port: settings.listen.port });
  clearPidRecordOnExit();
  return running.url;
}

export async function ensureProxyRunning(): Promise<{ url: string; token: string }> {
  const settings = applyEnvOverrides(loadSettings());
  exportTokenEnv(settings);
  const url = proxyUrl(settings);
  const token = settings.proxyAuthToken;
  const health = await fetchProxyHealth(url);
  if (health?.ok && !isStaleProxy(health, localCodeBuiltAt())) return { url, token };
  if (running) return { url: running.url, token };
  if (health?.ok && !(await replaceStaleProxy(url))) return { url, token };
  const pid = spawnDetachedProxy();
  writePidRecord({ pid, kind: "detached", port: settings.listen.port });
  if (!(await waitUntilHealthy(url))) {
    throw new Error(`proxy did not become healthy at ${url}`);
  }
  return { url, token };
}

function exportTokenEnv(settings: Settings): void {
  process.env[TOKEN_ENV] = settings.proxyAuthToken;
  process.env[OPENCODE_LAUNCHER_TOKEN_ENV] = settings.proxyAuthToken;
}

export function exportProxyToken(): void {
  exportTokenEnv(applyEnvOverrides(loadSettings()));
}
