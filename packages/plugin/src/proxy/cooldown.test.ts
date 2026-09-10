import assert from "node:assert/strict";
import test from "node:test";

import {
  __resetCooldowns,
  __setNow,
  activeCooldowns,
  clearCooldown,
  isCooldowned,
  parseRetryAfterHeader,
  recordCooldown,
  remainingCoolMs,
} from "./cooldown.js";

let tick = 0;
function setClock(ms: number): void {
  tick = ms;
  __setNow(() => tick);
}

test("parseRetryAfterHeader handles seconds and HTTP-date", () => {
  assert.equal(parseRetryAfterHeader("120", 0), 120_000);
  assert.equal(parseRetryAfterHeader(" 30 ", 0), 30_000);
  const future = new Date(0).toUTCString();
  assert.equal(parseRetryAfterHeader(future, 0), 0);
  const inAnHour = new Date(0 + 3600_000).toUTCString();
  assert.equal(parseRetryAfterHeader(inAnHour, 0), 3600_000);
  assert.equal(parseRetryAfterHeader(null, 0), null);
  assert.equal(parseRetryAfterHeader("garbage", 0), null);
});

test("recordCooldown skips a slug until Retry-After elapses, then clears", () => {
  __resetCooldowns();
  setClock(0);
  recordCooldown("open_router/qwen/qwen3-coder:free", "open_router", {
    status: 429,
    retryAfter: 60_000,
  });
  assert.equal(isCooldowned("open_router/qwen/qwen3-coder:free"), true);
  assert.equal(remainingCoolMs("open_router/qwen/qwen3-coder:free"), 60_000);
  const active = activeCooldowns();
  assert.equal(active.length, 1);
  assert.equal(active[0].slug, "open_router/qwen/qwen3-coder:free");
  assert.equal(active[0].availableAt, 60_000);

  // Time travel past the window: eligible again (recheck).
  setClock(60_001);
  assert.equal(isCooldowned("open_router/qwen/qwen3-coder:free"), false);
  assert.equal(remainingCoolMs("open_router/qwen/qwen3-coder:free"), 0);

  clearCooldown("open_router/qwen/qwen3-coder:free");
  assert.equal(activeCooldowns().length, 0);
});

test("429 without Retry-After uses the default 60s, capped at 30 min", () => {
  __resetCooldowns();
  setClock(0);
  recordCooldown("open_router/openrouter/free", "open_router", { status: 429 });
  assert.equal(remainingCoolMs("open_router/openrouter/free"), 60_000);

  // A repeat backoff doubles, but never exceeds the 30-minute cap.
  recordCooldown("open_router/openrouter/free", "open_router", { status: 429 });
  assert.ok(
    remainingCoolMs("open_router/openrouter/free") <= 30 * 60 * 1000,
    "backoff is capped at 30 min"
  );
  assert.ok(remainingCoolMs("open_router/openrouter/free") >= 120_000);

  // A 552 status (retryable 5xx) also cools down.
  setClock(0);
  recordCooldown("groq/llama-3.3-70b-versatile", "groq", { status: 552, retryAfter: 5 });
  assert.ok(isCooldowned("groq/llama-3.3-70b-versatile"));
  setClock(5001);
  assert.equal(isCooldowned("groq/llama-3.3-70b-versatile"), false);
});

test("cooldown is per-slug and cleared by a later 200 hop", () => {
  __resetCooldowns();
  setClock(0);
  recordCooldown("open_router/openrouter/free", "open_router", { status: 429 });
  assert.equal(isCooldowned("open_router/openrouter/free"), true);
  // A different slug is untouched.
  assert.equal(isCooldowned("groq/llama-3.3-70b-versatile"), false);
  clearCooldown("open_router/openrouter/free");
  assert.equal(isCooldowned("open_router/openrouter/free"), false);
});
