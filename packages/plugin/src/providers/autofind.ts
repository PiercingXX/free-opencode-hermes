import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";

import { connectProvider, isProviderConfigured, type Settings } from "../config/settings.js";
import { mapPool } from "../map-pool.js";
import { keepToolCapableModel } from "../proxy/models.js";
import type { FoundHost } from "./inventory.js";

const execFileAsync = promisify(execFile);

export type AutofindScope = "loopback" | "lan" | "tailscale";

export type AutofindHit = {
  scope: AutofindScope;
  host: string;
  kind: string;
  port: number;
  baseUrl: string;
  models: string[];
};

export type AutofindReport = {
  hits: AutofindHit[];
  connected: string[];
  notes: string[];
};

type ProbeSpec = {
  kind: string;
  port: number;
  path: string;
  models: (body: Record<string, unknown>) => string[];
};

function openAiModelIds(body: Record<string, unknown>): string[] {
  return ((body.data as Array<{ id?: string }> | undefined) ?? [])
    .map((row) => row.id)
    .filter((id): id is string => Boolean(id));
}

/**
 * OpenAI-compatible servers share /v1/models. Prefer owned_by from the listing
 * when present so llama.cpp on :30000/:30001 is not labeled as SGLang.
 */
export function kindFromOpenAiBody(body: Record<string, unknown>, fallback: string): string {
  const rows = (body.data as Array<{ owned_by?: string }> | undefined) ?? [];
  const owners = rows
    .map((row) => row.owned_by?.trim().toLowerCase())
    .filter((owner): owner is string => Boolean(owner));
  for (const owner of owners) {
    if (owner === "llamacpp" || owner === "llama.cpp" || owner === "llama-cpp") return "llamacpp";
    if (owner === "sglang") return "sglang";
    if (owner === "vllm") return "vllm";
    if (owner === "lmstudio" || owner === "lm studio") return "lmstudio";
  }
  return fallback;
}

const openAiProbe = (kind: string, port: number): ProbeSpec => ({
  kind,
  port,
  path: "/v1/models",
  models: openAiModelIds,
});

const PROBES: ProbeSpec[] = [
  {
    kind: "ollama",
    port: 11434,
    path: "/api/tags",
    models: (body) =>
      ((body.models as Array<{ name?: string; model?: string }> | undefined) ?? [])
        .map((row) => row.name || row.model)
        .filter((id): id is string => Boolean(id)),
  },
  openAiProbe("sglang", 30000),
  // Common second OpenAI-compat port (llama.cpp next to SGLang on the same box).
  openAiProbe("llamacpp", 30001),
  openAiProbe("vllm", 8000),
  openAiProbe("llamacpp", 8080),
  openAiProbe("lmstudio", 1234),
];

/** Built-in catalog provider ids a hit claims first (by scope, then kind). */
const BUILTIN_IDS: Partial<Record<AutofindScope, Record<string, string>>> = {
  loopback: { ollama: "ollama", sglang: "sglang", llamacpp: "llamacpp", lmstudio: "lmstudio" },
  tailscale: { ollama: "tailscale_ollama", sglang: "tailscale_sglang" },
};

/** True when `id` is a built-in catalog entry for this kind (no found-host card needed). */
function isBuiltinId(kind: string, id: string): boolean {
  return Object.values(BUILTIN_IDS).some((ids) => ids?.[kind] === id);
}

export type AutofindDeps = {
  fetchImpl?: typeof fetch;
  listTailscaleHosts?: () => Promise<string[]>;
  listLanHosts?: () => Promise<string[]>;
  timeoutMs?: number;
  concurrency?: number;
};

function toolModels(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => keepToolCapableModel({ id, supportsTools: null })))];
}

function isLoopbackHost(host: string): boolean {
  const n = host.toLowerCase();
  return n === "localhost" || n === "127.0.0.1" || n === "::1";
}

function isTailscaleV4(host: string): boolean {
  const parts = host.split(".").map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function isPrivateV4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (isTailscaleV4(host)) return true;
  return false;
}

export function scopeForHost(host: string): AutofindScope {
  if (isLoopbackHost(host)) return "loopback";
  if (isTailscaleV4(host)) return "tailscale";
  return "lan";
}

export function safeProviderId(kind: string, host: string): string {
  const hostPart = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${kind}-${hostPart || "host"}`;
}

export function assignProviderId(hit: AutofindHit, used: Set<string>): string {
  const builtin = BUILTIN_IDS[hit.scope]?.[hit.kind];
  if (builtin && !used.has(builtin)) return builtin;
  const base = safeProviderId(hit.kind, hit.host);
  let id = base;
  for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

type ProbeHit = { kind: string; models: string[] };

async function probeOne(
  host: string,
  spec: ProbeSpec,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<ProbeHit | null> {
  const url = `http://${host}:${spec.port}${spec.path}`;
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    const models = toolModels(spec.models(body));
    const kind = spec.path === "/v1/models" ? kindFromOpenAiBody(body, spec.kind) : spec.kind;
    return { kind, models };
  } catch {
    return null;
  }
}

export async function defaultTailscaleHosts(): Promise<{ hosts: string[]; note?: string }> {
  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"], { timeout: 8_000 });
    const status = JSON.parse(stdout) as {
      Self?: { DNSName?: string; TailscaleIPs?: string[] };
      Peer?: Record<string, { Online?: boolean; DNSName?: string; HostName?: string }>;
    };
    const hosts: string[] = [];
    const selfName = (status.Self?.DNSName ?? "").replace(/\.$/, "").split(".")[0];
    if (selfName && !isLoopbackHost(selfName)) hosts.push(selfName);
    for (const ip of status.Self?.TailscaleIPs ?? []) {
      if (ip.includes(".")) hosts.push(ip);
    }
    for (const peer of Object.values(status.Peer ?? {})) {
      if (peer.Online === false) continue;
      const name = (peer.DNSName ?? "").replace(/\.$/, "").split(".")[0] || peer.HostName;
      if (name) hosts.push(name);
    }
    return { hosts: [...new Set(hosts)] };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    const reason = err.code === "ENOENT" ? "tailscale CLI not on PATH" : err.message;
    return { hosts: [], note: `Tailscale skipped (${reason}).` };
  }
}

export function lanHostsFromArpTable(text: string): string[] {
  const ips: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
    if (!match) continue;
    const ip = match[1];
    if (isPrivateV4(ip) && !isLoopbackHost(ip)) ips.push(ip);
  }
  return [...new Set(ips)];
}

export async function defaultLanHosts(): Promise<string[]> {
  const ips = new Set<string>();
  for (const rows of Object.values(networkInterfaces())) {
    for (const row of rows ?? []) {
      if (row.internal) continue;
      if (String(row.family) !== "IPv4") continue;
      if (isPrivateV4(row.address)) ips.add(row.address);
    }
  }
  try {
    for (const ip of lanHostsFromArpTable(readFileSync("/proc/net/arp", "utf8"))) ips.add(ip);
  } catch {
    // not Linux, or no ARP table
  }
  return [...ips].slice(0, 24);
}

export async function runAutofind(deps: AutofindDeps = {}): Promise<AutofindReport> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 800;
  const concurrency = deps.concurrency ?? 16;
  const notes: string[] = [];

  const targets: Array<{ host: string; scope: AutofindScope }> = [
    { host: "127.0.0.1", scope: "loopback" },
  ];

  let tailscaleHosts: string[];
  if (deps.listTailscaleHosts) {
    tailscaleHosts = await deps.listTailscaleHosts();
  } else {
    const listed = await defaultTailscaleHosts();
    tailscaleHosts = listed.hosts;
    if (listed.note) notes.push(listed.note);
  }
  for (const host of tailscaleHosts) {
    if (isLoopbackHost(host)) continue;
    targets.push({ host, scope: "tailscale" });
  }

  const lanHosts = deps.listLanHosts ? await deps.listLanHosts() : await defaultLanHosts();
  if (!deps.listLanHosts && lanHosts.length === 0) {
    notes.push("No LAN neighbors in ARP. Only localhost and Tailscale were probed.");
  }
  for (const host of lanHosts) {
    if (isLoopbackHost(host)) continue;
    targets.push({ host, scope: scopeForHost(host) });
  }

  const jobs = targets.flatMap((target) => PROBES.map((spec) => ({ ...target, spec })));
  const results = await mapPool(jobs, concurrency, async (job) => {
    const probed = await probeOne(job.host, job.spec, timeoutMs, fetchImpl);
    if (!probed) return null;
    const port = job.spec.port;
    const hit: AutofindHit = {
      scope: job.scope,
      host: job.host,
      kind: probed.kind,
      port,
      baseUrl: `http://${job.host}:${port}/v1`,
      models: probed.models,
    };
    return hit;
  });

  const hits: AutofindHit[] = [];
  const seen = new Set<string>();
  for (const hit of results) {
    if (!hit) continue;
    // One listener per host:port — kind may be refined from owned_by.
    const key = `${hit.host}|${hit.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(hit);
  }

  const rank: Record<AutofindScope, number> = { loopback: 0, tailscale: 1, lan: 2 };
  hits.sort(
    (a, b) =>
      rank[a.scope] - rank[b.scope] || a.kind.localeCompare(b.kind) || a.host.localeCompare(b.host)
  );
  return { hits, connected: [], notes };
}

export function applyAutofindResults(
  settings: Settings,
  report: AutofindReport
): {
  settings: Settings;
  report: AutofindReport;
} {
  const used = new Set<string>();
  let next = settings;
  const connected: string[] = [];
  const extras: FoundHost[] = [...(settings.foundHosts ?? [])];
  const extraById = new Map(extras.map((row) => [row.id, row]));

  for (const hit of report.hits) {
    let id = assignProviderId(hit, used);
    const existingUrl = next.extra[id]?.baseUrl?.trim();
    if (existingUrl && existingUrl !== hit.baseUrl && isProviderConfigured(next, id)) {
      id = assignProviderId(hit, new Set([...used, id]));
    }
    used.add(id);
    next = connectProvider(next, id, { baseUrl: hit.baseUrl }, hit.models);
    connected.push(id);
    if (isBuiltinId(hit.kind, id)) continue;
    extraById.set(id, {
      id,
      kind: hit.kind,
      scope: hit.scope,
      host: hit.host,
      label: `${hit.host} · ${hit.kind}`,
      baseUrl: hit.baseUrl,
      models: hit.models,
    });
  }

  next = { ...next, foundHosts: [...extraById.values()] };
  return { settings: next, report: { ...report, connected: [...new Set(connected)] } };
}
