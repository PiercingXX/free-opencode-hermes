import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../paths.js";
import type { ProviderDescriptor, ProviderFamily } from "./catalog.js";
import { settingsSnapshot } from "../config/settings-snapshot.js";

export type FoundHost = {
  id: string;
  kind: string;
  scope: "loopback" | "lan" | "tailscale";
  host: string;
  label: string;
  baseUrl: string;
  models: string[];
};

/** Self-hosted runtime kinds: model-list family, placeholder API key, default port. */
const RUNTIME_KINDS: Record<
  string,
  { family: ProviderFamily; staticKey: string; defaultPort: number }
> = {
  ollama: { family: "ollama", staticKey: "ollama", defaultPort: 11434 },
  sglang: { family: "openai", staticKey: "sglang", defaultPort: 30000 },
  "llama-cpp": { family: "openai", staticKey: "llamacpp", defaultPort: 8080 },
  llamacpp: { family: "openai", staticKey: "llamacpp", defaultPort: 8080 },
  lmstudio: { family: "openai", staticKey: "lm-studio", defaultPort: 1234 },
  vllm: { family: "openai", staticKey: "vllm", defaultPort: 8000 },
};

type InventoryRuntime = {
  kind?: string;
  port?: number;
  enabled?: boolean;
  notes?: string;
  models?: Array<{ name?: string } | string>;
};

type InventoryMachine = {
  id?: string;
  label?: string;
  network?: { scope?: string; address?: string };
  runtimes?: InventoryRuntime[];
};

type InventoryFile = {
  machines?: InventoryMachine[];
};

export type InventoryLane = {
  providerId: string;
  machineId: string;
  label: string;
  kind: string;
  scope: string;
  endpoint: string;
  enabled: boolean;
  notes: string;
  models: string[];
};

let cache: { path: string; mtime: number; lanes: InventoryLane[] } | null = null;

function inventoryPath(): string | null {
  const primary = join(repoRoot(), "inventory.json");
  if (existsSync(primary)) return primary;
  const fallback = join(repoRoot(), "inventory.example.json");
  return existsSync(fallback) ? fallback : null;
}

function runtimeModels(runtime: InventoryRuntime): string[] {
  const out: string[] = [];
  for (const row of runtime.models ?? []) {
    const name = typeof row === "string" ? row : row.name;
    if (name?.trim()) out.push(name.trim());
  }
  return out;
}

export function loadInventoryLanes(): InventoryLane[] {
  const path = inventoryPath();
  if (!path) return [];
  let mtime: number;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    return [];
  }
  if (cache && cache.path === path && cache.mtime === mtime) return cache.lanes;

  let parsed: InventoryFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as InventoryFile;
  } catch {
    cache = { path, mtime, lanes: [] };
    return [];
  }

  const lanes: InventoryLane[] = [];
  for (const machine of parsed.machines ?? []) {
    const machineId = machine.id?.trim();
    const address = machine.network?.address?.trim();
    const scope = machine.network?.scope?.trim() || "unknown";
    if (!machineId || !address) continue;
    // Loopback runtimes are the built-in ollama/sglang/… catalog entries.
    if (scope === "localhost" || scope === "loopback") continue;
    for (const runtime of machine.runtimes ?? []) {
      const kind = runtime.kind?.trim();
      if (!kind || !RUNTIME_KINDS[kind]) continue;
      if (machineId.startsWith("example-") && runtime.enabled !== true) continue;
      const port = Number(runtime.port) || RUNTIME_KINDS[kind].defaultPort;
      const providerId = `${kind}-${machineId}`.replace(/[^a-zA-Z0-9_-]+/g, "-");
      lanes.push({
        providerId,
        machineId,
        label: `${machine.label || machineId} · ${kind}`,
        kind,
        scope,
        endpoint: `http://${address}:${port}/v1`,
        enabled: runtime.enabled === true,
        notes: runtime.notes?.trim() || "",
        models: runtimeModels(runtime),
      });
    }
  }
  cache = { path, mtime, lanes };
  return lanes;
}

/** A self-hosted provider card whose base URL is required and prefilled. */
function selfHostedDescriptor(
  id: string,
  name: string,
  kind: string,
  baseUrl: string,
  models: string[],
  notes: string
): ProviderDescriptor {
  const spec = RUNTIME_KINDS[kind] ?? RUNTIME_KINDS.sglang;
  return {
    id,
    name,
    local: true,
    family: spec.family,
    staticKey: spec.staticKey,
    defaultBaseUrl: baseUrl,
    extra: [{ key: "baseUrl", label: "Base URL", placeholder: baseUrl, required: true }],
    defaultModels: models,
    notes,
  };
}

export function inventoryProviders(): ProviderDescriptor[] {
  return loadInventoryLanes().map((lane) => {
    const notes = [
      lane.enabled ? `From inventory (${lane.scope}).` : `From inventory, currently disabled.`,
      lane.notes,
    ]
      .filter(Boolean)
      .join(" ");
    return selfHostedDescriptor(
      lane.providerId,
      lane.label,
      lane.kind,
      lane.endpoint,
      lane.models,
      notes
    );
  });
}

export function foundHostProviders(): ProviderDescriptor[] {
  return (settingsSnapshot()?.foundHosts ?? []).map((host) =>
    selfHostedDescriptor(
      host.id,
      host.label || `${host.host} · ${host.kind}`,
      host.kind,
      host.baseUrl,
      host.models ?? [],
      `Found on ${host.scope} (${host.host}).`
    )
  );
}

/** Generic Tailscale catalog entries → the runtime kind an enabled inventory lane can fill. */
const TAILSCALE_GENERIC_KINDS: Record<string, string> = {
  tailscale_ollama: "ollama",
  tailscale_sglang: "sglang",
};

export function suggestedBaseUrl(providerId: string): string {
  const baseProviderId = providerId.split("@")[0];
  const lanes = loadInventoryLanes();
  const lane = lanes.find((row) => row.providerId === baseProviderId);
  if (lane) return lane.endpoint;
  const kind = TAILSCALE_GENERIC_KINDS[baseProviderId];
  if (!kind) return "";
  const hit = lanes.find((row) => row.enabled && row.kind === kind && row.scope === "tailscale");
  return hit?.endpoint ?? "";
}
