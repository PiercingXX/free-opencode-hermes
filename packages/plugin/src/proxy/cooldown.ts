/**
 * Rate-limit / quota cooldown for the Free OpenCode router.
 *
 * When an upstream returns 429 / 402 / rate-limit / retryable 5xx, that model
 * slug is marked "expended" and is skipped by routeTargets() until `availableAt`
 * elapses. This stops a drained free box from getting hammered once a turn;
 * the first request after expiry is the recheck (there is no background timer).
 *
 * Cooldowns are persisted to a schema-versioned JSON file under
 * `~/.free-opencode/cooldowns.json` (see cooldownStatePath()) so they survive a
 * proxy / service restart — a restart must not silently come back up on a model
 * that was just 402/429'd, or overnight would re-hit gpt-5-nano every time the
 * service bounces. The file stores only slug / provider / availableAt / reason
 * / retryAfterSeconds: no API keys. Loaded on proxy start (expired entries
 * dropped), saved on every record or clear. A persist failure is non-fatal and
 * announced once on stderr, matching the route log.
 *
 * Backoff rules (per slug):
 *   - Retry-After (seconds or HTTP-date) quoted by the upstream wins.
 *   - Otherwise the default is 60s for a quota (429 / 402) or retryable 5xx,
 *     doubled on each repeat, capped at the 30-minute ceiling.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { cooldownStatePath } from "../paths.js";
import { appendLog } from "./route-log.js";

/** Hard cap for both the default backoff and any parsed Retry-After. */
export const COOLDOWN_MAX_MS = 30 * 60 * 1000;
/** 429 default when no Retry-After is given. */
const COOLDOWN_DEFAULT_MS = 60 * 1000;

function realNow(): number {
  return Date.now();
}

let now: () => number = realNow;

/** Test-only: rewind/forward the clock so cooldown expiry is deterministic. */
export function __setNow(fn: () => number): void {
  now = fn;
}

/** Test-only: clear every cooldown and reset the clock + persistence seams. */
export function __resetCooldowns(): void {
  store.clear();
  now = realNow;
  persistHome = null;
  announcedPersistError = null;
}

export type CooldownEntry = {
  slug: string;
  providerId: string;
  availableAt: number;
  reason: string;
  retryAfterSeconds?: number;
};

export const COOLDOWN_PERSIST_SCHEMA = 1;

/** On-disk shape. Never carries keys, tokens, or request bodies. */
type PersistedCooldownState = {
  schemaVersion: number;
  cooldowns: CooldownEntry[];
};

const store = new Map<string, CooldownEntry>();

/** Active home used for persistence when a mutation omits `home`. */
let persistHome: string | null = null;
/** Non-fatal write/parse failure is announced on stderr once per distinct error. */
let announcedPersistError: string | null = null;

/**
 * Point the store at a cooldown file and load any persisted cooldowns. Expired
 * entries are dropped (their window already passed), so a restarted probe does
 * not waste a request on a slot that would have been rechecked anyway. Best
 * effort: a missing / corrupt / older-schema file leaves the store empty and
 * never throws.
 */
export function loadCooldowns(home?: string): void {
  persistHome = home ?? null;
  try {
    const raw = readFileSync(cooldownStatePath(persistHome ?? undefined), "utf8");
    const parsed = JSON.parse(raw) as PersistedCooldownState;
    if (!parsed || parsed.schemaVersion !== COOLDOWN_PERSIST_SCHEMA) return;
    if (!Array.isArray(parsed.cooldowns)) return;
    const nowMs = now();
    const loaded: CooldownEntry[] = [];
    for (const entry of parsed.cooldowns) {
      if (!entry || typeof entry.slug !== "string" || !entry.slug) continue;
      if (typeof entry.providerId !== "string") continue;
      if (typeof entry.availableAt !== "number") continue;
      if (entry.availableAt <= nowMs) continue; // expired — drop
      loaded.push({
        slug: entry.slug,
        providerId: entry.providerId,
        availableAt: entry.availableAt,
        reason: typeof entry.reason === "string" ? entry.reason : "restored",
        retryAfterSeconds:
          typeof entry.retryAfterSeconds === "number" ? entry.retryAfterSeconds : undefined,
      });
    }
    store.clear();
    for (const entry of loaded) store.set(entry.slug, entry);
  } catch {
    // missing file, unreadable, or not the current schema — start clean
  }
}

/**
 * Write the current cooldowns to the schema-versioned file. Synchronous and
 * best-effort: the file is tiny and writes are rare (only on record/clear), so
 * this keeps the store deterministic and the write immediately readable by
 * tests or the next process. Failure never throws — it is announced once.
 */
function persistCooldowns(home?: string): void {
  const target = home ?? persistHome;
  if (!target) return;
  const payload: PersistedCooldownState = {
    schemaVersion: COOLDOWN_PERSIST_SCHEMA,
    cooldowns: activeCooldowns(),
  };
  try {
    const path = cooldownStatePath(target);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    announcedPersistError = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (announcedPersistError !== message) {
      announcedPersistError = message;
      console.error(`free-opencode cooldowns: persist failed (non-fatal): ${message}`);
    }
  }
}

/** Parse an HTTP Retry-After header (seconds or HTTP-date) into ms from now. */
export function parseRetryAfterHeader(
  value: string | null | undefined,
  from = now()
): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  // HTTP-date is an absolute instant; report how long from `from` until then.
  return Math.max(0, parsed - from);
}

/** How many ms a slug is still cooled down for right now (0 when eligible). */
export function remainingCoolMs(slug: string): number {
  const entry = store.get(slug);
  if (!entry) return 0;
  return Math.max(0, entry.availableAt - now());
}

export function isCooldowned(slug: string): boolean {
  return remainingCoolMs(slug) > 0;
}

export function activeCooldowns(): CooldownEntry[] {
  const out: CooldownEntry[] = [];
  for (const entry of store.values()) {
    const remain = entry.availableAt - now();
    if (remain > 0) {
      out.push({ ...entry, availableAt: entry.availableAt });
    }
  }
  out.sort((a, b) => a.availableAt - b.availableAt);
  return out;
}

/** Next attempt time in ms since epoch for a slug, or null when not cooled down. */
function attemptAt(slug: string): number | null {
  const entry = store.get(slug);
  if (!entry) return null;
  return entry.availableAt > now() ? entry.availableAt : null;
}

/** Success clears the cooldown for a slug. Failed non-rate-limit clears too. */
export function clearCooldown(slug: string, home?: string): void {
  store.delete(slug);
  persistCooldowns(home);
}

/**
 * Record a rate-limit / quota / retryable failure for a slug. Derives the
 * next-available time from Retry-After or the per-slug exponential backoff.
 * Logs a `cooldown` route record (secret-free) so the trail shows why a slug
 * is being skipped. Never throws.
 */
export function recordCooldown(
  slug: string,
  providerId: string,
  opts: {
    status?: number;
    retryAfterSeconds?: number;
    /** Parsed Retry-After as an absolute+relative ms duration (already computed). */
    retryAfter?: number | null;
    reason?: string;
    home?: string;
  } = {}
): void {
  const status = opts.status ?? 0;
  const isQuota = status === 402 || status === 429;
  const base = store.get(slug);
  let delay: number;
  if (typeof opts.retryAfter === "number" && opts.retryAfter > 0) {
    delay = opts.retryAfter;
  } else if (opts.retryAfterSeconds != null && opts.retryAfterSeconds > 0) {
    delay = opts.retryAfterSeconds * 1000;
  } else {
    // Exponential backoff: double the previous default for this slug. Keyed off
    // the live entry's retryAfterSeconds (routeChat stores the upstream message
    // as `reason`, not a fixed token), so a repeat 429 doubles instead of
    // resetting to the 60s default.
    const prevMs = base && base.retryAfterSeconds ? base.retryAfterSeconds * 1000 : 0;
    delay = prevMs > 0 ? Math.min(prevMs * 2, COOLDOWN_MAX_MS) : COOLDOWN_DEFAULT_MS;
  }
  const capped = Math.min(Math.max(1, delay), COOLDOWN_MAX_MS);
  const reason = opts.reason ?? (isQuota ? "quota" : "retryable");
  store.set(slug, {
    slug,
    providerId,
    availableAt: now() + capped,
    reason,
    retryAfterSeconds: Math.round(capped / 1000),
  });
  void appendLog(
    "cooldown",
    {
      slug,
      providerId,
      status,
      reason,
      retryAfterSeconds: Math.round(capped / 1000),
      availableAt: new Date(now() + capped).toISOString(),
    },
    opts.home
  );
  persistCooldowns(opts.home);
}

/** Returns the instant (ms epoch) a cooled-down slug may be retried, else null. */
export function cooldownAvailableAt(slug: string): number | null {
  return attemptAt(slug);
}
