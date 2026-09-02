import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { repoRoot, settingsPath } from "../paths.js";
import type { ProviderDescriptor, ProviderFamily } from "./catalog.js";

export type FoundHost = {
  id: string;
  kind: string;
  scope: "loopback" | "lan" | "tailscale";
  host: string;
  label: string;
  baseUrl: string;
  models: string[];
};

const KIND_PORTS: Record<
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
  let mtime = 0;
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
    const local = scope === "localhost" || scope === "loopback";
    for (const runtime of machine.runtimes ?? []) {
      const kind = runtime.kind?.trim();
      if (!kind || !KIND_PORTS[kind]) continue;
      if (local) continue;
      if (machineId.startsWith("example-") && runtime.enabled !== true) continue;
      const port = Number(runtime.port) || KIND_PORTS[kind].defaultPort;
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

export function inventoryProviders(): ProviderDescriptor[] {
  return loadInventoryLanes().map((lane) => {
    const spec = KIND_PORTS[lane.kind];
    return {
      id: lane.providerId,
      name: lane.label,
      local: true,
      family: spec.family,
      staticKey: spec.staticKey,
      defaultBaseUrl: lane.endpoint,
      extra: [
        {
          key: "baseUrl",
          label: "Base URL",
          placeholder: lane.endpoint,
          required: true,
        },
      ],
      defaultModels: lane.models,
      notes: [
        lane.enabled ? `From inventory (${lane.scope}).` : `From inventory, currently disabled.`,
        lane.notes,
      ]
        .filter(Boolean)
        .join(" "),
    };
  });
}

export function foundHostProviders(): ProviderDescriptor[] {
  const path = settingsPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { foundHosts?: FoundHost[] };
    const hosts = Array.isArray(parsed.foundHosts) ? parsed.foundHosts : [];
    return hosts
      .filter((host) => host?.id && host.baseUrl)
      .map((host) => {
        const spec = KIND_PORTS[host.kind] ?? KIND_PORTS.sglang;
        return {
          id: host.id,
          name: host.label || `${host.host} · ${host.kind}`,
          local: true,
          family: spec.family,
          staticKey: spec.staticKey,
          defaultBaseUrl: host.baseUrl,
          extra: [
            {
              key: "baseUrl",
              label: "Base URL",
              placeholder: host.baseUrl,
              required: true,
            },
          ],
          defaultModels: host.models ?? [],
          notes: `Found on ${host.scope} (${host.host}).`,
        };
      });
  } catch {
    return [];
  }
}

export function suggestedBaseUrl(providerId: string): string {
  const lane = loadInventoryLanes().find((row) => row.providerId === providerId);
  if (lane) return lane.endpoint;
  const enabled = loadInventoryLanes().filter((row) => row.enabled);
  if (providerId === "tailscale_ollama") {
    const hit = enabled.find((row) => row.kind === "ollama" && row.scope === "tailscale");
    return hit?.endpoint ?? "";
  }
  if (providerId === "tailscale_sglang") {
    const hit = enabled.find((row) => row.kind === "sglang" && row.scope === "tailscale");
    return hit?.endpoint ?? "";
  }
  return "";
}
