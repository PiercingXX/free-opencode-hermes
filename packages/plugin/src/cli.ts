#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  addAccount,
  applyEnvOverrides,
  connectProvider,
  isAccountQualified,
  isProviderConfigured,
  loadSettings,
  readyProviderIds,
  removeProvider,
  saveSettings,
  setProviderKey,
  splitAccountQualifier,
} from "./config/settings.js";
import { launchHermes } from "./launchers/hermes.js";
import { launchOpenCode } from "./launchers/opencode.js";
import { pidPath, TOKEN_ENV } from "./paths.js";
import {
  localCodeBuiltAt,
  spawnDetachedProxy,
  stopDetachedProxy,
  waitUntilHealthy,
} from "./plugin/lifecycle.js";
import { serviceInstall, serviceStatus, serviceUninstall } from "./plugin/service.js";
import { cmdUpdate } from "./plugin/update.js";
import { applyAutofindResults, runAutofind } from "./providers/autofind.js";
import { allProviders, providerById, providerExtraFields } from "./providers/catalog.js";
import { suggestedBaseUrl } from "./providers/inventory.js";
import { buildModelCatalog, probeProvider } from "./proxy/models.js";
import { fetchProxyHealth, isStaleProxy, startProxy, waitForListen } from "./proxy/server.js";
import { appendLog, readLogTail, type RouteHopRecord } from "./proxy/route-log.js";

function usage(): never {
  console.log(`Free OpenCode

Usage:
  free-opencode start [--foreground]
  free-opencode stop
  free-opencode status
  free-opencode connect [provider-id[@account-id]] [--account <label>]
  free-opencode autofind
  free-opencode remove [provider-id[@account-id]]
  free-opencode models [--free]
  free-opencode set-model <provider/model>
  free-opencode set-fallback <provider/model> [...]
  free-opencode accounts [provider-id]
  free-opencode admin
  free-opencode log [--lines <n>]
  free-opencode service install|uninstall|status
  free-opencode update
  free-opencode overnight [--parallel]
  free-opencode opencode [args...]
  free-opencode hermes [args...]

Launchers (also installed as foc-opencode and foc-hermes):
  foc-opencode     OpenCode against the :8082 catalog (Responses, process-local config)
  foc-hermes       Hermes Agent against the same :8082 catalog (codex_responses)
  xx-hermes        Hermes against the :8180 GPU/Ollama orchestrator (separate plane)
`);
  process.exit(1);
}

async function cmdOvernight(parallel: boolean): Promise<void> {
  await cmdStart(false);
  const agent = parallel ? "parallel-execution-orchestrator" : "execution-orchestrator";
  console.log(
    parallel
      ? "Overnight multi-lane: independent slices across available Free OpenCode models (GPU last)."
      : "Overnight single-lane: one Free OpenCode session (free cloud → paid → GPU last)."
  );
  console.log(`Agent: ${agent}`);
  await launchOpenCode(["--agent", agent]);
}

async function cmdStart(foreground: boolean): Promise<void> {
  const settings = applyEnvOverrides(loadSettings());
  process.env[TOKEN_ENV] = settings.proxyAuthToken;
  const url = `http://${settings.listen.host}:${settings.listen.port}`;
  const health = await fetchProxyHealth(url);
  if (health?.ok && !isStaleProxy(health, localCodeBuiltAt())) {
    console.log(`Already running at ${url}`);
    console.log(`Admin: ${url}/admin`);
    return;
  }
  if (health?.ok) {
    stopDetachedProxy();
    console.log("Replaced stale proxy with the current build.");
  }
  if (!foreground) {
    const pid = spawnDetachedProxy();
    writeFileSync(pidPath(), `${pid}\n`);
    console.log(`Proxy ${url} (pid ${pid})`);
    console.log(`Admin ${url}/admin`);
    return;
  }
  const proxy = startProxy(settings);
  await waitForListen(proxy);
  writeFileSync(pidPath(), `${process.pid}\n`);
  console.log(`Proxy ${proxy.url}`);
  console.log(`Admin ${proxy.url}/admin`);
  const stop = (): void => {
    void proxy.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {
    /* run until signal */
  });
}

function cmdStop(): void {
  try {
    const pid = Number(readFileSync(pidPath(), "utf8").trim());
    stopDetachedProxy();
    void appendLog("proxy.stop", { pid: pid > 0 ? pid : undefined });
    console.log("Stopped.");
  } catch {
    console.log("Proxy was not running (or pid file missing).");
  }
}

async function cmdStatus(): Promise<void> {
  const settings = applyEnvOverrides(loadSettings());
  const url = `http://${settings.listen.host}:${settings.listen.port}`;
  const health = await fetchProxyHealth(url);
  console.log(`url: ${url}`);
  console.log(`admin: ${url}/admin`);
  const ok = Boolean(health?.ok);
  console.log(`health: ${ok ? "ok" : "down"}`);
  if (ok) {
    printLastRoute(health?.lastRoute ?? null);
    printCooldowns(health?.cooldowns ?? []);
  }
  console.log(`default model: ${settings.model ?? "(unset)"}`);
  console.log(`fallbacks: ${settings.fallbacks.join(", ") || "(none)"}`);
  console.log(`ready: ${readyProviderIds(settings).join(", ") || "(none)"}`);
}

function printCooldowns(
  cooldowns: Array<{ slug: string; providerId: string; availableAt: number; reason?: string }>
): void {
  if (cooldowns.length === 0) return;
  console.log("cooldowns:");
  for (const c of cooldowns) {
    const when = c.availableAt
      ? `back ${new Date(c.availableAt).toLocaleTimeString()}`
      : "back later";
    console.log(`  ${c.slug} · ${when}${c.reason ? ` · ${c.reason}` : ""}`);
  }
}

function printLastRoute(route: RouteHopRecord | null): void {
  console.log(`last route: ${formatRoute(route)}`);
}

function formatRoute(route: RouteHopRecord | null): string {
  if (!route) return "(none yet)";
  const where = route.providerId ? `${route.slug} [${route.providerId}]` : route.slug;
  const ms = `${route.latencyMs}ms`;
  const outcome = route.ok ? "ok" : `failed ${route.status ?? "transport"}`;
  const fallback =
    route.fallback === false || route.fallback === 0 ? "" : ` · fallback#${route.fallback}`;
  return `${where} · ${outcome} · ${ms}${route.tried && route.tried.length > 1 ? ` · tried: ${route.tried.join(" → ")}` : ""}${fallback}`;
}

function formatConnectRow(p: ReturnType<typeof allProviders>[number]): string {
  const extra = providerExtraFields(p).find((field) => field.key === "baseUrl");
  const hint = p.local
    ? p.defaultBaseUrl || extra?.placeholder || "set a base URL"
    : p.credentialUrl || "";
  return `${p.id.padEnd(24)} ${p.local ? "self-hosted" : "cloud".padEnd(11)}  ${p.name}  ${hint}`;
}

async function cmdConnect(providerId?: string): Promise<void> {
  const catalog = allProviders().filter((p) => !p.unsupported);
  if (!providerId) {
    const local = catalog.filter((p) => p.local && !isAccountQualified(p.id));
    const cloud = catalog.filter((p) => !p.local && p.env && !isAccountQualified(p.id));
    console.log("Self-hosted (Connect probes the URL and lists models):\n");
    console.log(local.map(formatConnectRow).join("\n"));
    console.log("\nCloud (paste an API key):\n");
    console.log(cloud.map(formatConnectRow).join("\n"));
    console.log("\nThen: free-opencode connect ollama");
    console.log("      free-opencode connect tailscale_sglang");
    console.log("      free-opencode connect open_router@work");
    console.log("      free-opencode connect open_router --account work");
    return;
  }
  const { provider: baseProviderId, account } = splitAccountQualifier(providerId);
  const provider = providerById(baseProviderId);
  if (!provider || provider.unsupported) {
    console.error(`Unknown provider '${baseProviderId}'`);
    process.exit(1);
  }
  if (provider.credentialUrl) console.log(`Key URL: ${provider.credentialUrl}`);
  if (provider.notes) console.log(provider.notes);
  const rl = createInterface({ input, output });
  try {
    const extra: Record<string, string> = {};
    for (const field of providerExtraFields(provider)) {
      const preset =
        applyEnvOverrides(loadSettings()).extra[provider.id]?.[field.key] ||
        suggestedBaseUrl(provider.id) ||
        field.placeholder ||
        provider.defaultBaseUrl ||
        "";
      const prompt = preset ? `${field.label} [${preset}]: ` : `${field.label}: `;
      const value = (await rl.question(prompt)).trim() || preset;
      if (value) extra[field.key] = value;
      else if (field.required) {
        console.error(`${field.label} is required.`);
        process.exit(1);
      }
    }
    let settings = applyEnvOverrides(loadSettings());
    // If the user gave an account-qualified provider, ensure the account exists
    if (account) {
      try {
        const result = addAccount(settings, baseProviderId, account);
        settings = result.settings;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    }
    const resolvedProviderId = account ? `${baseProviderId}@${account}` : baseProviderId;
    const resolvedProvider = providerById(resolvedProviderId) ?? provider;

    if (resolvedProvider.local) {
      settings = {
        ...settings,
        extra: {
          ...settings.extra,
          [resolvedProviderId]: {
            ...settings.extra[resolvedProviderId],
            ...extra,
          },
        },
      };
      const probed = await probeProvider(settings, resolvedProvider);
      if (!probed.ok) {
        console.error(
          `Could not reach ${resolvedProvider.name} at ${probed.baseUrl}: ${probed.error}`
        );
        process.exit(1);
      }
      settings = connectProvider(settings, resolvedProviderId, extra, probed.models);
      saveSettings(settings);
      console.log(`Connected ${resolvedProviderId} at ${probed.baseUrl}`);
      if (probed.models.length === 0)
        console.log("No models listed. Pull or load one, then connect again.");
      else {
        console.log(`Models (${probed.models.length}):`);
        for (const model of probed.models.slice(0, 20))
          console.log(`  ${resolvedProviderId}/${model}`);
        if (probed.models.length > 20) console.log(`  … ${probed.models.length - 20} more`);
      }
      console.log(`Default model: ${settings.model ?? "(unset)"}`);
      return;
    }
    if (!provider.env) {
      console.error(`Provider '${providerId}' is not connectable.`);
      process.exit(1);
    }
    const key = (await rl.question(`${provider.name} API key: `)).trim();
    if (!key) {
      console.error("No key entered.");
      process.exit(1);
    }
    settings = setProviderKey(settings, resolvedProviderId, key, extra);
    saveSettings(settings);
    console.log(`Saved ${resolvedProviderId}. Default model: ${settings.model ?? "(unchanged)"}`);
  } finally {
    rl.close();
  }
}

async function cmdAutofind(): Promise<void> {
  console.log("Scanning localhost, LAN neighbors, and Tailscale…");
  const report = await runAutofind();
  for (const note of report.notes) console.log(note);
  const applied = applyAutofindResults(applyEnvOverrides(loadSettings()), report);
  saveSettings(applied.settings);
  if (applied.report.hits.length === 0) {
    console.log("No self-hosted endpoints answered.");
    return;
  }
  for (const hit of applied.report.hits) {
    const models =
      hit.models.length === 0 ? "no tool models listed" : hit.models.slice(0, 8).join(", ");
    console.log(`  ${hit.scope.padEnd(10)} ${hit.kind.padEnd(10)} ${hit.baseUrl}  ${models}`);
  }
  console.log(`Connected: ${applied.report.connected.join(", ")}`);
  console.log(`Default model: ${applied.settings.model ?? "(unset)"}`);
}

function cmdRemove(providerId?: string): void {
  const settings = applyEnvOverrides(loadSettings());
  const configured = allProviders().filter((p) => isProviderConfigured(settings, p.id));
  if (!providerId) {
    if (configured.length === 0) {
      console.log("No saved providers. Connect one with: free-opencode connect");
      return;
    }
    console.log(
      "Saved providers (remove drops keys, URLs, hosted models, and self-hosted cards):\n"
    );
    for (const p of configured) {
      const ready = readyProviderIds(settings).includes(p.id) ? "ready" : "saved";
      console.log(`  ${p.id.padEnd(24)} ${ready.padEnd(6)}  ${p.name}`);
    }
    console.log("\nThen: free-opencode remove nvidia_nim");
    console.log("      free-opencode remove open_router@work");
    return;
  }
  const { provider: baseProviderId, account } = splitAccountQualifier(providerId);
  const provider = providerById(baseProviderId);
  if (!provider || provider.unsupported) {
    console.error(`Unknown provider '${baseProviderId}'`);
    process.exit(1);
  }
  const resolvedProviderId = account ? `${baseProviderId}@${account}` : baseProviderId;
  if (!isProviderConfigured(settings, resolvedProviderId)) {
    console.log(`${resolvedProviderId} is not saved.`);
    return;
  }
  const next = removeProvider(settings, resolvedProviderId);
  saveSettings(next);
  console.log(`Removed ${resolvedProviderId}.`);
  console.log(`Default model: ${next.model ?? "(unset)"}`);
  console.log(`Fallbacks: ${next.fallbacks.join(", ") || "(none)"}`);
  console.log(`Ready: ${readyProviderIds(next).join(", ") || "(none)"}`);
}

async function cmdModels(freeOnly: boolean): Promise<void> {
  const settings = applyEnvOverrides(loadSettings());
  const models = await buildModelCatalog(settings);
  const rows = freeOnly ? models.filter((model) => model.free) : models;
  if (rows.length === 0) {
    console.log(
      freeOnly
        ? "No free tool models yet. Connect OpenCode Zen or OpenRouter."
        : "No models. Connect a provider: free-opencode connect"
    );
    return;
  }
  for (const model of rows) {
    console.log(model.free ? `${model.id}  free` : model.id);
  }
}

function cmdSetModel(slug: string): void {
  const settings = applyEnvOverrides(loadSettings());
  settings.model = slug;
  saveSettings(settings);
  console.log(`Default model: ${slug}`);
}

function cmdSetFallback(slugs: string[]): void {
  const settings = applyEnvOverrides(loadSettings());
  settings.fallbacks = slugs;
  saveSettings(settings);
  console.log(`Fallbacks: ${slugs.join(", ")}`);
}

function cmdAccounts(targetProvider?: string): void {
  const settings = applyEnvOverrides(loadSettings());
  const accounts = settings.accounts ?? [];
  const rows = targetProvider ? accounts.filter((a) => a.providerId === targetProvider) : accounts;
  if (rows.length === 0) {
    console.log(
      targetProvider
        ? `No accounts for ${targetProvider}. Add one: free-opencode connect ${targetProvider}@<name>`
        : "No named accounts. Add one: free-opencode connect open_router@work"
    );
    return;
  }
  for (const account of rows) {
    console.log(
      `  ${account.providerId}@${account.id}${account.label ? `  (${account.label})` : ""}`
    );
  }
}

async function cmdLog(linesValue: number): Promise<void> {
  const n = Number.isInteger(linesValue) && linesValue > 0 ? Math.min(linesValue, 500) : 50;
  const lines = await readLogTail(n);
  for (const line of lines) console.log(JSON.stringify(line));
}

async function cmdService(action: string | undefined): Promise<void> {
  switch (action) {
    case "install": {
      // Stop any detached proxy first so the service owns the port cleanly.
      stopDetachedProxy();
      try {
        serviceInstall();
        console.log("Keep-alive service installed.");
      } catch (error) {
        console.error(
          `Could not install the keep-alive service (proxy still runs manually): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      // Give the unit/task a beat to bring the proxy up under the service. If it
      // is still down (e.g. systemd slow, or the unit could not be created), fall
      // back to a detached proxy. Never block on a foreground proxy here — the
      // installers call `service install` and would otherwise hang forever.
      const settings = applyEnvOverrides(loadSettings());
      const url = `http://${settings.listen.host}:${settings.listen.port}`;
      if (!(await waitUntilHealthy(url))) {
        await cmdStart(false);
      }
      return;
    }
    case "uninstall":
      serviceUninstall();
      stopDetachedProxy();
      console.log(
        "Keep-alive service removed. Run `free-opencode start` to run the proxy on demand."
      );
      return;
    case "status": {
      const status = serviceStatus();
      console.log(
        `service: ${status.installed ? "installed" : "not installed"} (${status.source})`
      );
      console.log(`running: ${status.running ? "yes" : "no"}`);
      if (status.detail) console.log(status.detail);
      if (process.platform === "linux" && !status.installed) {
        console.log(
          "Tip: on a headless box, `loginctl enable-linger $USER` keeps the user service alive after logout."
        );
      }
      return;
    }
    case undefined:
    case "":
      usage();
      return;
    default:
      console.error(`Unknown service action '${action}'. Use install, uninstall, or status.`);
      process.exit(1);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "start":
    await cmdStart(rest.includes("--foreground"));
    break;
  case "stop":
    cmdStop();
    break;
  case "status":
    await cmdStatus();
    break;
  case "connect": {
    let accountFlag: string | undefined;
    let connectTarget: string | undefined;
    const args = rest.slice();
    const flagIndex = args.findIndex((a) => a === "--account" || a === "-a");
    if (flagIndex >= 0) {
      accountFlag = args[flagIndex + 1];
      args.splice(flagIndex, flagIndex + 1 <= args.length ? 2 : 1);
    }
    connectTarget = args[0];
    // If --account was given but the target already embeds an @, that wins.
    // Otherwise append @account to the bare provider.
    if (accountFlag && connectTarget && !connectTarget.includes("@")) {
      connectTarget = `${connectTarget}@${accountFlag}`;
    } else if (accountFlag && !connectTarget) {
      console.error("--account requires a provider id");
      process.exit(1);
    }
    await cmdConnect(connectTarget);
    break;
  }
  case "autofind":
    await cmdAutofind();
    break;
  case "remove":
  case "disconnect":
    cmdRemove(rest[0]);
    break;
  case "models":
    await cmdModels(rest.includes("--free"));
    break;
  case "set-model":
    if (!rest[0]) usage();
    cmdSetModel(rest[0]);
    break;
  case "set-fallback":
    cmdSetFallback(rest);
    break;
  case "accounts":
    cmdAccounts(rest[0]);
    break;
  case "admin":
    {
      const settings = applyEnvOverrides(loadSettings());
      console.log(`http://${settings.listen.host}:${settings.listen.port}/admin`);
    }
    break;
  case "log":
    {
      const index = rest.findIndex((a) => a === "--lines" || a === "-n");
      const n = index >= 0 ? Number(rest[index + 1]) : 50;
      await cmdLog(n);
    }
    break;
  case "service":
    await cmdService(rest[0]);
    break;
  case "update":
    await cmdUpdate();
    break;
  case "overnight":
    await cmdOvernight(rest.includes("--parallel"));
    break;
  case "opencode":
    await launchOpenCode(rest);
    break;
  case "hermes":
    await launchHermes(rest);
    break;
  default:
    usage();
}
