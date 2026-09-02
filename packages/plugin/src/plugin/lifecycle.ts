import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { applyEnvOverrides, loadSettings } from "../config/settings.js";
import { OPENCODE_LAUNCHER_TOKEN_ENV, TOKEN_ENV, pidPath } from "../paths.js";
import { killPid, nodeExecutable } from "../platform.js";
import { fetchProxyHealth, isStaleProxy, startProxy, waitForListen } from "../proxy/server.js";

let running: Awaited<ReturnType<typeof startProxy>> | null = null;

export function proxyUrlFromSettings(): string {
  const settings = applyEnvOverrides(loadSettings());
  return `http://${settings.listen.host}:${settings.listen.port}`;
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

export function stopDetachedProxy(): void {
  try {
    const pid = Number(readFileSync(pidPath(), "utf8").trim());
    if (pid > 0) killPid(pid);
  } catch {
    // no pid file
  }
  try {
    unlinkSync(pidPath());
  } catch {
    // already gone
  }
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

async function waitUntilHealthy(url: string): Promise<boolean> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const health = await fetchProxyHealth(url);
    if (health?.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

export async function ensureProxyInProcess(): Promise<string> {
  const settings = applyEnvOverrides(loadSettings());
  const url = `http://${settings.listen.host}:${settings.listen.port}`;
  const health = await fetchProxyHealth(url);
  if (health?.ok && !isStaleProxy(health, localCodeBuiltAt())) return url;
  if (health?.ok) stopDetachedProxy();
  if (running) return running.url;
  running = startProxy(settings);
  await waitForListen(running);
  writeFileSync(pidPath(), `${process.pid}\n`);
  return running.url;
}

export async function ensureProxyRunning(): Promise<{ url: string; token: string }> {
  const settings = applyEnvOverrides(loadSettings());
  process.env[TOKEN_ENV] = settings.proxyAuthToken;
  process.env[OPENCODE_LAUNCHER_TOKEN_ENV] = settings.proxyAuthToken;
  const url = `http://${settings.listen.host}:${settings.listen.port}`;
  const health = await fetchProxyHealth(url);
  if (health?.ok && !isStaleProxy(health, localCodeBuiltAt())) {
    return { url, token: settings.proxyAuthToken };
  }
  if (health?.ok) stopDetachedProxy();
  if (running) return { url: running.url, token: settings.proxyAuthToken };
  const pid = spawnDetachedProxy();
  writeFileSync(pidPath(), `${pid}\n`);
  if (!(await waitUntilHealthy(url))) {
    throw new Error(`proxy did not become healthy at ${url}`);
  }
  return { url, token: settings.proxyAuthToken };
}

export function exportProxyToken(): void {
  const settings = applyEnvOverrides(loadSettings());
  process.env[TOKEN_ENV] = settings.proxyAuthToken;
  process.env[OPENCODE_LAUNCHER_TOKEN_ENV] = settings.proxyAuthToken;
}
