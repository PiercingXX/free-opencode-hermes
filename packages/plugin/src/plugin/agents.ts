import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { xxStackDir } from "../paths.js";

export type InjectedAgent = {
  name: string;
  prompt: string;
  description?: string;
  mode?: "subagent" | "primary" | "all";
  temperature?: number;
  steps?: number;
  permission?: {
    edit?: "ask" | "allow" | "deny";
    bash?: "ask" | "allow" | "deny";
  };
};

const SKIP = new Set(["ping.md", "planning.md", "researcher.md"]);

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith("---")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: raw };
  const yaml = raw.slice(4, end);
  const body = raw.slice(end + 4).replace(/^\s+/, "");
  const meta: Record<string, string> = {};
  let prefix = "";
  for (const line of yaml.split("\n")) {
    if (!line.trim()) continue;
    const nested = /^ {2}([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (nested && prefix) {
      meta[`${prefix}.${nested[1]}`] = nested[2].trim();
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    prefix = match[2] ? "" : match[1];
    if (match[2]) meta[match[1]] = match[2].trim();
  }
  return { meta, body };
}

function asMode(value: string | undefined): InjectedAgent["mode"] {
  if (value === "primary" || value === "subagent" || value === "all") return value;
  return undefined;
}

function asPermission(value: string | undefined): "ask" | "allow" | "deny" | undefined {
  if (value === "ask" || value === "allow" || value === "deny") return value;
  return undefined;
}

type RegistryAgent = {
  description?: string;
  mode?: string;
  temperature?: number;
  steps?: number;
  permission?: { edit?: string; bash?: string };
};

function asSteps(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function loadRuntimeAgents(stackDir = xxStackDir()): InjectedAgent[] {
  const dir = join(stackDir, "runtime", "agents");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".md") && !name.endsWith(".nano.md"));
  } catch {
    return [];
  }

  let registry: Record<string, RegistryAgent> = {};
  try {
    const config = JSON.parse(readFileSync(join(stackDir, "runtime", "config.json"), "utf8")) as {
      agent?: Record<string, RegistryAgent>;
    };
    registry = config.agent ?? {};
  } catch {
    registry = {};
  }

  const agents: InjectedAgent[] = [];
  for (const file of files) {
    if (SKIP.has(file)) continue;
    const raw = readFileSync(join(dir, file), "utf8");
    const { meta, body } = parseFrontmatter(raw);
    const name = meta.name || file.replace(/\.md$/, "");
    const fromRegistry = registry[name] ?? {};
    agents.push({
      name,
      prompt: body,
      description: fromRegistry.description ?? meta.description,
      mode: asMode(fromRegistry.mode) ?? asMode(meta.mode),
      temperature:
        typeof fromRegistry.temperature === "number"
          ? fromRegistry.temperature
          : meta.temperature
            ? Number(meta.temperature)
            : undefined,
      steps: asSteps(fromRegistry.steps) ?? asSteps(meta.steps),
      permission: {
        edit: asPermission(fromRegistry.permission?.edit) ?? asPermission(meta["permission.edit"]),
        bash: asPermission(fromRegistry.permission?.bash) ?? asPermission(meta["permission.bash"]),
      },
    });
  }
  return agents;
}

export function loadSharedInstructions(stackDir = xxStackDir()): string {
  try {
    return readFileSync(join(stackDir, "runtime", "shared_instructions.md"), "utf8");
  } catch {
    return "";
  }
}
