import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { cooldownStatePath } from "../paths.js";
import {
  __resetCooldowns,
  __setNow,
  activeCooldowns,
  clearCooldown,
  COOLDOWN_PERSIST_SCHEMA,
  isCooldowned,
  loadCooldowns,
  parseRetryAfterHeader,
  recordCooldown,
  remainingCoolMs,
} from "./cooldown.js";

let tick = 0;
function setClock(ms: number): void {
  tick = ms;
  __setNow(() => tick);
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "foc-cooldown-"));
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

test("cooldowns persist across a proxy restart (load → record → reload)", () => {
  __resetCooldowns();
  setClock(0);
  const home = tempHome();

  // Simulate a fresh proxy process: point the store at this home and load.
  loadCooldowns(home);
  assert.equal(activeCooldowns().length, 0, "a fresh store starts empty");

  recordCooldown("open_router/openrouter/free", "open_router", {
    status: 429,
    retryAfter: 60_000,
    home,
  });
  assert.equal(isCooldowned("open_router/openrouter/free"), true);

  // The file exists, is schema-versioned, and holds no secret material.
  const statePath = cooldownStatePath(home);
  assert.ok(existsSync(statePath), "cooldown file is written under the temp home");
  const raw = readFileSync(statePath, "utf8");
  const parsed = JSON.parse(raw) as { schemaVersion: number; cooldowns: unknown[] };
  assert.equal(parsed.schemaVersion, COOLDOWN_PERSIST_SCHEMA);
  assert.ok(Array.isArray(parsed.cooldowns));
  assert.ok(!raw.includes("sk-"), "no API-key-shaped material in the cooldown file");
  assert.ok(!raw.includes("apiKey"));

  // Restart: clear memory, then load from disk as a fresh process would.
  __resetCooldowns();
  setClock(0);
  loadCooldowns(home);
  assert.equal(
    isCooldowned("open_router/openrouter/free"),
    true,
    "a restarted proxy still skips the expended slug"
  );
  assert.equal(remainingCoolMs("open_router/openrouter/free"), 60_000);

  // Clear is also persisted: a 200 hop removes the slug from the file too.
  clearCooldown("open_router/openrouter/free", home);
  __resetCooldowns();
  loadCooldowns(home);
  assert.equal(
    isCooldowned("open_router/openrouter/free"),
    false,
    "cleared cooldown stays cleared"
  );
});

test("loadCooldowns drops expired entries so a fresh probe is not wasted", () => {
  __resetCooldowns();
  setClock(0);
  const home = tempHome();
  loadCooldowns(home);
  recordCooldown("open_router/openrouter/free", "open_router", { status: 429, home });

  // Past the 60s window (clock jumped far past availableAt).
  setClock(120_000);
  __resetCooldowns();
  loadCooldowns(home);
  assert.equal(isCooldowned("open_router/openrouter/free"), false, "expired entry is dropped");
  assert.equal(activeCooldowns().length, 0);
});

test("schema-versioned only file loads: wrong schema version starts clean", () => {
  __resetCooldowns();
  setClock(0);
  const home = tempHome();
  const statePath = cooldownStatePath(home);
  // Write a newer-schema file by hand; a current reader treats it as a format
  // it does not own and must not crash or resurrect stale entries from it.
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify({
      schemaVersion: COOLDOWN_PERSIST_SCHEMA + 1,
      cooldowns: [{ slug: "x/a", providerId: "x", availableAt: 999_999_999_999 }],
    }),
    "utf8"
  );
  loadCooldowns(home);
  assert.equal(activeCooldowns().length, 0, "foreign schema is ignored, store stays clean");
});
