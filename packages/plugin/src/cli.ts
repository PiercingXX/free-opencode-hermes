#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  applyEnvOverrides,
  connectProvider,
  isProviderConfigured,
  loadSettings,
  readyProviderIds,
  removeProvider,
  saveSettings,
  setProviderKey,
} from "./config/settings.js";
import { launchHermes } from "./launchers/hermes.js";
import { launchOpenCode } from "./launchers/opencode.js";
import { pidPath, TOKEN_ENV } from "./paths.js";
import { localCodeBuiltAt, spawnDetachedProxy, stopDetachedProxy } from "./plugin/lifecycle.js";
import { applyAutofindResults, runAutofind } from "./providers/autofind.js";
import { allProviders, providerById, providerExtraFields } from "./providers/catalog.js";
import { suggestedBaseUrl } from "./providers/inventory.js";
import { buildModelCatalog, probeProvider } from "./proxy/models.js";
import {
  fetchProxyHealth,
  isStaleProxy,
  proxyHealth,
  startProxy,
  waitForListen,
} from "./proxy/server.js";

function usage(): never {
  console.log(`Free OpenCode

Usage:
  free-opencode start [--foreground]
  free-opencode stop
  free-opencode status
  free-opencode connect [provider-id]
  free-opencode autofind
  free-opencode remove [provider-id]
  free-opencode models [--free]
  free-opencode set-model <provider/model>
  free-opencode set-fallback <provider/model> [...]
  free-opencode admin
  free-opencode opencode [args...]
  free-opencode hermes [args...]

Launchers (also installed as foc-opencode and foc-hermes):
  foc-opencode     OpenCode against the :8082 catalog (Responses, process-local config)
  foc-hermes       Hermes Agent against the same :8082 catalog (codex_responses)
  xx-hermes        Hermes against the :8180 GPU/Ollama orchestrator (separate plane)
`);
  process.exit(1);
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
    readFileSync(pidPath(), "utf8");
    stopDetachedProxy();
    console.log("Stopped.");
  } catch {
    console.log("Proxy was not running (or pid file missing).");
  }
}

async function cmdStatus(): Promise<void> {
  const settings = applyEnvOverrides(loadSettings());
  const url = `http://${settings.listen.host}:${settings.listen.port}`;
  const ok = await proxyHealth(url);
  console.log(`url: ${url}`);
  console.log(`admin: ${url}/admin`);
  console.log(`health: ${ok ? "ok" : "down"}`);
  console.log(`default model: ${settings.model ?? "(unset)"}`);
  console.log(`fallbacks: ${settings.fallbacks.join(", ") || "(none)"}`);
  console.log(`ready: ${readyProviderIds(settings).join(", ") || "(none)"}`);
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
    const local = catalog.filter((p) => p.local);
    const cloud = catalog.filter((p) => !p.local && p.env);
    console.log("Self-hosted (Connect probes the URL and lists models):\n");
    console.log(local.map(formatConnectRow).join("\n"));
    console.log("\nCloud (paste an API key):\n");
    console.log(cloud.map(formatConnectRow).join("\n"));
    console.log("\nThen: free-opencode connect ollama");
    console.log("      free-opencode connect tailscale_sglang");
    return;
  }
  const provider = providerById(providerId);
  if (!provider || provider.unsupported) {
    console.error(`Unknown provider '${providerId}'`);
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
    if (provider.local) {
      let settings = applyEnvOverrides(loadSettings());
      settings = {
        ...settings,
        extra: { ...settings.extra, [provider.id]: { ...settings.extra[provider.id], ...extra } },
      };
      const probed = await probeProvider(settings, provider);
      if (!probed.ok) {
        console.error(`Could not reach ${provider.name} at ${probed.baseUrl}: ${probed.error}`);
        process.exit(1);
      }
      settings = connectProvider(settings, provider.id, extra, probed.models);
      saveSettings(settings);
      console.log(`Connected ${provider.id} at ${probed.baseUrl}`);
      if (probed.models.length === 0)
        console.log("No models listed. Pull or load one, then connect again.");
      else {
        console.log(`Models (${probed.models.length}):`);
        for (const model of probed.models.slice(0, 20)) console.log(`  ${provider.id}/${model}`);
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
    const settings = setProviderKey(applyEnvOverrides(loadSettings()), provider.id, key, extra);
    saveSettings(settings);
    console.log(`Saved ${provider.id}. Default model: ${settings.model ?? "(unchanged)"}`);
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
    return;
  }
  const provider = providerById(providerId);
  if (!provider || provider.unsupported) {
    console.error(`Unknown provider '${providerId}'`);
    process.exit(1);
  }
  if (!isProviderConfigured(settings, provider.id)) {
    console.log(`${provider.id} is not saved.`);
    return;
  }
  const next = removeProvider(settings, provider.id);
  saveSettings(next);
  console.log(`Removed ${provider.id}.`);
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
  case "connect":
    await cmdConnect(rest[0]);
    break;
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
  case "admin":
    {
      const settings = applyEnvOverrides(loadSettings());
      console.log(`http://${settings.listen.host}:${settings.listen.port}/admin`);
    }
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
