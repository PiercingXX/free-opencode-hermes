/**
 * Provider-level circuit breaker.
 *
 * Cooldowns (cooldown.ts) are per model slug: one drained free model is
 * skipped while its siblings keep serving. That is the wrong tool when the
 * whole provider is down — the router would walk every one of its models,
 * each failing with a 5xx or a timeout, before reaching a healthy provider.
 *
 * The breaker trips on provider-level failures only (network errors, 408,
 * 5xx). Account/quota errors (401/402/403/429) are per key or per model and
 * stay with cooldowns. States:
 *
 *   closed → traffic allowed; consecutive failures are counted
 *   open   → provider skipped until `openUntil`
 *   after the hold expires the provider is allowed again (half-open): a
 *   success closes the breaker, a failure re-opens it with a doubled hold.
 *
 * State is in memory only: a restart gives every provider a fresh chance,
 * which is the right default for a local proxy. No background timers.
 */

/** Consecutive provider-level failures before the breaker opens. */
export const BREAKER_FAILURE_THRESHOLD = 3;
const BASE_HOLD_MS = 30_000;
const LOCAL_BASE_HOLD_MS = 15_000;
const MAX_HOLD_MS = 5 * 60_000;

type BreakerEntry = {
  failures: number;
  /** 0 = never tripped since the last success. */
  openUntil: number;
  holdMs: number;
};

const entries = new Map<string, BreakerEntry>();
let now: () => number = () => Date.now();

/** Only provider-wide failures count: transport errors, timeouts and 5xx. */
export function isProviderLevelFailure(status: number | null): boolean {
  return status === null || status === 408 || status >= 500;
}

/** Whether requests may go to this provider right now (pure read). */
export function breakerAllows(providerId: string): boolean {
  const entry = entries.get(providerId);
  return !entry || now() >= entry.openUntil;
}

export function recordProviderSuccess(providerId: string): void {
  entries.delete(providerId);
}

export function recordProviderFailure(providerId: string, local = false): void {
  const base = local ? LOCAL_BASE_HOLD_MS : BASE_HOLD_MS;
  const entry = entries.get(providerId) ?? { failures: 0, openUntil: 0, holdMs: 0 };
  entry.failures += 1;
  if (entry.openUntil > 0) {
    // Half-open probe failed: back off harder.
    entry.holdMs = Math.min(entry.holdMs * 2, MAX_HOLD_MS);
    entry.openUntil = now() + entry.holdMs;
  } else if (entry.failures >= BREAKER_FAILURE_THRESHOLD) {
    entry.holdMs = base;
    entry.openUntil = now() + base;
  }
  entries.set(providerId, entry);
}

export type OpenBreaker = { providerId: string; openUntil: number; failures: number };

export function openBreakers(): OpenBreaker[] {
  const out: OpenBreaker[] = [];
  for (const [providerId, entry] of entries) {
    if (now() < entry.openUntil) {
      out.push({ providerId, openUntil: entry.openUntil, failures: entry.failures });
    }
  }
  return out;
}

/** Test hooks. */
export function __resetBreakers(): void {
  entries.clear();
}

export function __setBreakerNow(fn: () => number): void {
  now = fn;
}
