/**
 * Rate-limit / quota cooldown for the Free OpenCode router.
 *
 * When an upstream returns 429 / 402 / rate-limit / retryable 5xx, that model
 * slug is marked "expended" and is skipped by routeTargets() until `availableAt`
 * elapses. This stops a drained free box from getting hammered once a turn;
 * the first request after expiry is the recheck (there is no background timer).
 *
 * The store is in-memory only for v1. Cooldowns do not survive a proxy restart
 * — that is a deliberate trade: restart clears them, and a fresh process starts
 * clean. Nothing secret is stored or logged.
 *
 * Backoff rules (per slug):
 *   - Retry-After (seconds or HTTP-date) quoted by the upstream wins.
 *   - Otherwise the default is 60s for a quota (429 / 402) or retryable 5xx,
 *     doubled on each repeat, capped at the 30-minute ceiling.
 */

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

/** Test-only: clear every cooldown and reset the clock seam. */
export function __resetCooldowns(): void {
  store.clear();
  now = realNow;
}

export type CooldownEntry = {
  slug: string;
  providerId: string;
  availableAt: number;
  reason: string;
  retryAfterSeconds?: number;
};

const store = new Map<string, CooldownEntry>();

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
export function clearCooldown(slug: string): void {
  store.delete(slug);
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
}

/** Returns the instant (ms epoch) a cooled-down slug may be retried, else null. */
export function cooldownAvailableAt(slug: string): number | null {
  return attemptAt(slug);
}
