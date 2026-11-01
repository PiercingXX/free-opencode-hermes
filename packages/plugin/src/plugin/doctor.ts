/**
 * `free-opencode doctor [--fix]` — a read-mostly health check of the local
 * install. Prints a pass/warn/fail table; any "fail" makes the command exit 1.
 *
 * `--fix` only does safe, local repairs: chmod 0600 on the settings file and
 * removal of a stale pidfile. It never rewrites settings or auth.json.
 */

import { chmodSync, existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";

import {
  applyEnvOverrides,
  normalizeSettings,
  readyProviderIds,
  type Settings,
} from "../config/settings.js";
import { PROVIDER_ID, pidPath, settingsPath } from "../paths.js";
import { providerById } from "../providers/catalog.js";
import { probeProvider, type ProbeResult } from "../proxy/models.js";
import { fetchProxyHealth, type ProxyHealth } from "../proxy/server.js";
import { readOpenCodeAuth } from "./auth.js";
import { inspectPidfile, proxyUrl } from "./lifecycle.js";

export type CheckStatus = "pass" | "warn" | "fail";
export type Check = { name: string; status: CheckStatus; detail: string };

export type DoctorOptions = {
  home?: string;
  fix?: boolean;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  probeTimeoutMs?: number;
  /** Test seams. */
  fetchHealth?: (url: string) => Promise<ProxyHealth | null>;
  portFree?: (host: string, port: number) => Promise<boolean>;
  probe?: (settings: Settings, providerId: string) => Promise<ProbeResult>;
};

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost|\[::1\])$/i;

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.test(host.trim());
}

function portIsFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

function timedFetch(timeoutMs: number): typeof fetch {
  return (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

function checkNode(version: string): Check {
  const major = Number(/^v?(\d+)/.exec(version)?.[1] ?? 0);
  return major >= 20
    ? { name: "node", status: "pass", detail: version }
    : { name: "node", status: "fail", detail: `${version} (need >= 20)` };
}

function checkSettingsFile(
  path: string,
  fix: boolean,
  platform: NodeJS.Platform
): { check: Check; settings: Settings | null } {
  if (!existsSync(path)) {
    return {
      check: { name: "settings", status: "warn", detail: `${path} missing (created on first run)` },
      settings: null,
    };
  }
  let settings: Settings;
  try {
    settings = applyEnvOverrides(normalizeSettings(JSON.parse(readFileSync(path, "utf8"))));
  } catch (error) {
    return {
      check: {
        name: "settings",
        status: "fail",
        detail: `${path} does not parse: ${error instanceof Error ? error.message : String(error)}`,
      },
      settings: null,
    };
  }
  if (platform === "win32") {
    return { check: { name: "settings", status: "pass", detail: path }, settings };
  }
  const mode = statSync(path).mode & 0o777;
  if (mode === 0o600) {
    return { check: { name: "settings", status: "pass", detail: `${path} (0600)` }, settings };
  }
  const octal = mode.toString(8).padStart(4, "0");
  if (fix) {
    try {
      chmodSync(path, 0o600);
      return {
        check: { name: "settings", status: "pass", detail: `${path} fixed ${octal} -> 0600` },
        settings,
      };
    } catch (error) {
      return {
        check: {
          name: "settings",
          status: "warn",
          detail: `chmod 0600 failed: ${error instanceof Error ? error.message : String(error)}`,
        },
        settings,
      };
    }
  }
  return {
    check: {
      name: "settings",
      status: "warn",
      detail: `${path} is ${octal}, should be 0600 (holds API keys; run doctor --fix)`,
    },
    settings,
  };
}

async function checkPort(
  settings: Settings,
  health: ProxyHealth | null,
  opts: DoctorOptions
): Promise<Check> {
  const url = proxyUrl(settings);
  if (health?.ok && health.service === "free-opencode") {
    return { name: "proxy port", status: "pass", detail: `${url} held by our proxy` };
  }
  if (health) {
    return {
      name: "proxy port",
      status: "fail",
      detail: `${url} answers but is not the Free OpenCode proxy`,
    };
  }
  const free = await (opts.portFree ?? portIsFree)(settings.listen.host, settings.listen.port);
  return free
    ? { name: "proxy port", status: "pass", detail: `${url} free (proxy not running)` }
    : {
        name: "proxy port",
        status: "fail",
        detail: `port ${settings.listen.port} is held by another process`,
      };
}

async function checkProviders(settings: Settings, opts: DoctorOptions): Promise<Check[]> {
  const ids = readyProviderIds(settings);
  if (ids.length === 0) {
    return [
      { name: "providers", status: "warn", detail: "none configured (free-opencode connect)" },
    ];
  }
  const fetchImpl = timedFetch(opts.probeTimeoutMs ?? 4000);
  const probe =
    opts.probe ??
    (async (s: Settings, id: string): Promise<ProbeResult> => {
      const provider = providerById(id);
      if (!provider) {
        return { ok: false, providerId: id, baseUrl: "", models: [], error: "unknown provider" };
      }
      return probeProvider(s, provider, fetchImpl);
    });
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        return await probe(settings, id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, providerId: id, baseUrl: "", models: [], error: message };
      }
    })
  );
  return results.map((r): Check => {
    if (r.ok) {
      return {
        name: `provider ${r.providerId}`,
        status: "pass",
        detail: `${r.models.length} model(s)`,
      };
    }
    // An offline self-hosted box is normal; an unreachable cloud API is not.
    const local = Boolean(providerById(r.providerId)?.local);
    return {
      name: `provider ${r.providerId}`,
      status: local ? "warn" : "fail",
      detail: `unreachable${r.baseUrl ? ` at ${r.baseUrl}` : ""}: ${r.error ?? "unknown error"}`,
    };
  });
}

function checkAuthJson(home: string): Check {
  const auth = readOpenCodeAuth(home);
  if (auth.state === "missing") {
    return { name: "opencode auth.json", status: "warn", detail: `${auth.path} missing` };
  }
  if (auth.state === "invalid") {
    return {
      name: "opencode auth.json",
      status: "fail",
      detail: `${auth.path} does not parse (${auth.error}); free-opencode will not rewrite it`,
    };
  }
  return PROVIDER_ID in auth.data
    ? { name: "opencode auth.json", status: "pass", detail: auth.path }
    : {
        name: "opencode auth.json",
        status: "warn",
        detail: `no ${PROVIDER_ID} entry yet (written when OpenCode loads the plugin)`,
      };
}

function checkPidfile(home: string, fix: boolean, healthPid?: number): Check {
  const path = pidPath(home);
  const state = inspectPidfile(path, healthPid);
  if (state.state === "none") return { name: "pidfile", status: "pass", detail: "none" };
  if (state.state === "live") return { name: "pidfile", status: "pass", detail: state.reason };
  if (fix) {
    try {
      unlinkSync(path);
      return { name: "pidfile", status: "pass", detail: `removed stale pidfile (${state.reason})` };
    } catch {
      // fall through to the warning
    }
  }
  return {
    name: "pidfile",
    status: "warn",
    detail: `stale: ${state.reason} (run doctor --fix to remove)`,
  };
}

export async function collectChecks(opts: DoctorOptions = {}): Promise<Check[]> {
  const home = opts.home ?? homedir();
  const fix = Boolean(opts.fix);
  const checks: Check[] = [checkNode(opts.nodeVersion ?? process.version)];
  const { check, settings } = checkSettingsFile(
    settingsPath(home),
    fix,
    opts.platform ?? process.platform
  );
  checks.push(check);
  let health: ProxyHealth | null = null;
  if (settings) {
    health = await (opts.fetchHealth ?? fetchProxyHealth)(proxyUrl(settings));
    checks.push(await checkPort(settings, health, opts));
    checks.push(
      settings.proxyAuthEnabled
        ? { name: "proxy auth", status: "pass", detail: "enabled" }
        : { name: "proxy auth", status: "warn", detail: "disabled — any local process can use it" }
    );
    checks.push(
      isLoopbackHost(settings.listen.host)
        ? { name: "listen host", status: "pass", detail: settings.listen.host }
        : {
            name: "listen host",
            status: "warn",
            detail: `${settings.listen.host} is not loopback; the proxy is reachable off-box`,
          }
    );
    checks.push(...(await checkProviders(settings, opts)));
  }
  checks.push(checkAuthJson(home));
  checks.push(checkPidfile(home, fix, health?.ok ? health.pid : undefined));
  return checks;
}

export function formatChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks
    .map((c) => `${c.status.toUpperCase().padEnd(4)}  ${c.name.padEnd(width)}  ${c.detail}`)
    .join("\n");
}

/** Run every check; `report` is the printable table plus a summary line. */
export async function runDoctor(
  opts: DoctorOptions = {}
): Promise<{ ok: boolean; report: string; checks: Check[] }> {
  const checks = await collectChecks(opts);
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const summary = `${failed} fail, ${warned} warn, ${checks.length - failed - warned} pass`;
  return { ok: failed === 0, report: `${formatChecks(checks)}\n\n${summary}`, checks };
}
