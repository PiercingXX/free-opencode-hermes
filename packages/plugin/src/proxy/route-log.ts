/**
 * Route + diagnostics log for the Free OpenCode proxy.
 *
 * One JSONL stream at `~/.free-opencode/proxy.log` (see logPath()). Every line
 * is a single JSON object. Two kinds of records share the file:
 *
 *   route attempt / final outcome   type: "route.attempt" / "route.result"
 *   diagnostics                     type: "proxy.start", "proxy.stop",
 *                                   "service.install", "update.step",
 *                                   "mcp.spawn", "plugin.error", ...
 *
 * The records never carry API keys, Authorization headers, or raw request
 * bodies — the caller constructs them key-free, and `appendLog` redacts known
 * secret shapes anyway as a second belt.
 *
 * Rotation mirrors xx-stack/mcp-server/src/log_worker.ts: when the file exceeds
 * 5 MiB it is renamed to proxy.log.1 before the next append. A write failure
 * never propagates and never takes down the proxy; it is announced once on
 * stderr, like the MCP server's telemetry sink.
 *
 * The in-memory ring (last ~20 routes) and `lastRoute` back the Admin page and
 * `free-opencode status`. They live here so Admin, the CLI, and the route log
 * agree on what the "last route" is without scraping HTML.
 */

import { readFile } from "node:fs/promises";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { logPath } from "../paths.js";

export const MAX_LOG_BYTES = 5 * 1024 * 1024;
let maxLogBytes = MAX_LOG_BYTES;
/** Test-only: shrink the rotation threshold so a small file exercises rotation. */
export function __setMaxLogBytes(n: number): void {
  maxLogBytes = n;
}

/** Test seam for the filesystem calls; only route-log.test swaps it. */
export const __logIo = { appendFile, mkdir, rename, stat };

export type RouteHopRecord = {
  at: string;
  /** Optional caller-supplied id linking attempt + outcome lines for one request. */
  requestId?: string;
  /** provider/model or provider@account/model that this HTTP call hit. */
  slug: string;
  providerId: string;
  /** HTTP status of the upstream call; null when transport failed before a response. */
  status: number | null;
  latencyMs: number;
  ok: boolean;
  /** false = primary attempt, number = failed fallbacks already tried (slots 1..). */
  fallback: boolean | number;
  /** Full fallback chain in the order tried for this request. */
  tried: string[];
  message?: string;
};

export type LastRoute = RouteHopRecord;

export const MAX_RING = 20;
const ring: LastRoute[] = [];
let lastRoute: LastRoute | null = null;
let announcedError: string | null = null;

export function recentRoutes(): LastRoute[] {
  return ring.slice();
}

/** Test-only: clear the in-memory ring and lastRoute so tests start clean. */
export function __resetRouteLog(): void {
  ring.length = 0;
  lastRoute = null;
  maxLogBytes = MAX_LOG_BYTES;
}

export function currentLastRoute(): LastRoute | null {
  return lastRoute;
}

export function recordLastRoute(home: string | undefined, hop: RouteHopRecord): void {
  void home;
  lastRoute = normalizeHop(hop);
  if (lastRoute) {
    ring.unshift(lastRoute);
    if (ring.length > MAX_RING) ring.length = MAX_RING;
  }
}

function normalizeHop(hop: RouteHopRecord): LastRoute {
  return {
    at: hop.at,
    requestId: hop.requestId,
    slug: hop.slug,
    providerId: hop.providerId,
    status: hop.status,
    latencyMs: hop.latencyMs,
    ok: hop.ok,
    fallback: hop.fallback,
    tried: [...(hop.tried ?? [])],
    ...(hop.message ? { message: hop.message } : {}),
  };
}

/** Secret-bearing field names and shapes that must never reach the log. */
const SECRET_FIELD = /authorization|api[-_]?key|token|secret|password|proxyauthtoken/i;
const SECRET_VALUE =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|[A-Za-z0-9]{40,})\b/g;

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(SECRET_VALUE, "[REDACTED]");
  }
  if (value && typeof value === "object") {
    return redactObject(value as Record<string, unknown>);
  }
  return value;
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SECRET_FIELD.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = redactValue(value);
  }
  return out;
}

async function rotateIfLarge(file: string): Promise<void> {
  try {
    const s = await __logIo.stat(file);
    if (s.size > maxLogBytes) {
      await __logIo.rename(file, `${file}.1`);
    }
  } catch {
    // file does not exist yet — nothing to rotate
  }
}

/**
 * Append one JSONL record. Never throws and never rejects; a failure is
 * announced once on stderr so a full disk cannot bury the log while a *new*
 * failure mode stays visible.
 */
export async function appendLog(
  type: string,
  payload: Record<string, unknown>,
  home?: string
): Promise<void> {
  try {
    const file = logPath(home);
    await __logIo.mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await rotateIfLarge(file);
    const line = JSON.stringify({ at: new Date().toISOString(), type, ...redactObject(payload) });
    await __logIo.appendFile(file, line + "\n", "utf8");
    announcedError = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (announcedError !== message) {
      announcedError = message;
      console.error(`free-opencode log: write failed (non-fatal): ${message}`);
    }
  }
}

/** Append a route attempt or final-outcome line and update the in-memory state. */
export async function logRoute(
  home: string | undefined,
  hop: Omit<RouteHopRecord, "at"> & { at?: string },
  type: "route.attempt" | "route.result"
): Promise<void> {
  const record: RouteHopRecord = { ...hop, at: hop.at ?? new Date().toISOString() };
  recordLastRoute(home, record);
  await appendLog(type, record, home);
}

/**
 * Read the last `limit` JSONL records, parsing each line. Returns raw parsed
 * objects, redacted. A torn tail line (mid-record file end) is dropped but the
 * records before it still come back. Read-only; callers use the returned array.
 */
export async function readLogTail(
  limit: number,
  home?: string
): Promise<Record<string, unknown>[]> {
  const file = logPath(home);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  const start = Math.max(0, lines.length - limit);
  const out: Record<string, unknown>[] = [];
  for (const raw of lines.slice(start)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      out.push(redactObject(parsed));
    } catch {
      // torn line — skip
    }
  }
  return out;
}
