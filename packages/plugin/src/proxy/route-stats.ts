/**
 * Per-slug routing signals learned from live traffic (in memory only):
 *
 *   - latency: exponentially weighted moving average of successful hops,
 *     used by the `auto/fast` alias to order candidates within a tier;
 *   - last known good: the slug that most recently answered, used by the
 *     `auto/sticky` alias so a conversation keeps hitting one provider
 *     (fewer hops, better upstream prompt-cache reuse);
 *   - context fit: the smallest request size (in characters) a slug rejected
 *     as a context overflow. Requests at least that large skip the slug
 *     instead of spending a round-trip on a guaranteed failure. A success at
 *     a larger size raises the limit again.
 *
 * Sizes are character counts of the serialized messages — a cheap,
 * deterministic proxy for tokens that needs no tokenizer.
 */

const EWMA_ALPHA = 0.3;

const latency = new Map<string, number>();
const contextLimit = new Map<string, number>();
let lastGood: string | null = null;

export function recordLatency(slug: string, ms: number): void {
  const prev = latency.get(slug);
  latency.set(slug, prev === undefined ? ms : prev + EWMA_ALPHA * (ms - prev));
}

/** Unknown slugs sort after measured ones, keeping their original order. */
export function latencyOf(slug: string): number {
  return latency.get(slug) ?? Number.POSITIVE_INFINITY;
}

export function recordSuccess(slug: string, requestChars: number): void {
  lastGood = slug;
  const limit = contextLimit.get(slug);
  if (limit !== undefined && requestChars >= limit) contextLimit.delete(slug);
}

export function lastKnownGood(): string | null {
  return lastGood;
}

/**
 * Below this size an "overflow" is not about the prompt (typically an
 * oversized max_tokens), so it teaches nothing about the context window.
 */
export const MIN_LEARNED_CONTEXT_CHARS = 8_000;

export function recordContextOverflow(slug: string, requestChars: number): void {
  if (requestChars < MIN_LEARNED_CONTEXT_CHARS) return;
  const limit = contextLimit.get(slug);
  if (limit === undefined || requestChars < limit) contextLimit.set(slug, requestChars);
}

/** False when this slug already overflowed on a request this large. */
export function fitsContext(slug: string, requestChars: number): boolean {
  const limit = contextLimit.get(slug);
  return limit === undefined || requestChars < limit;
}

export function requestSize(body: Record<string, unknown>): number {
  try {
    return JSON.stringify(body.messages ?? []).length;
  } catch {
    return 0;
  }
}

/** Test hook. */
export function __resetRouteStats(): void {
  latency.clear();
  contextLimit.clear();
  lastGood = null;
}
