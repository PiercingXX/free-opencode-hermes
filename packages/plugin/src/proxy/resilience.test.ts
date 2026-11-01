import assert from "node:assert/strict";
import test from "node:test";

import { addAccount, emptySettings, setProviderKey } from "../config/settings.js";
import {
  BREAKER_FAILURE_THRESHOLD,
  __resetBreakers,
  __setBreakerNow,
  breakerAllows,
  isProviderLevelFailure,
  recordProviderFailure,
  recordProviderSuccess,
} from "./breaker.js";
import { compactMessages, compactionMode, trimHeadTail } from "./compact.js";
import { __resetCooldowns } from "./cooldown.js";
import {
  MIN_LEARNED_CONTEXT_CHARS,
  __resetRouteStats,
  fitsContext,
  recordContextOverflow,
  recordLatency,
  recordSuccess,
} from "./route-stats.js";
import { routeChat, routeTargets, type ChatRequest, type RouteAttempt } from "./router.js";
import { SettingsStore } from "./settings-store.js";

function reset(): void {
  __resetBreakers();
  __resetCooldowns();
  __resetRouteStats();
}

test("breaker opens after consecutive provider-level failures, then half-opens", () => {
  reset();
  let now = 1_000;
  __setBreakerNow(() => now);
  for (let i = 0; i < BREAKER_FAILURE_THRESHOLD - 1; i += 1) recordProviderFailure("groq");
  assert.equal(breakerAllows("groq"), true, "below threshold stays closed");
  recordProviderFailure("groq");
  assert.equal(breakerAllows("groq"), false, "threshold opens");
  now += 30_000;
  assert.equal(breakerAllows("groq"), true, "hold expired → half-open");
  recordProviderFailure("groq");
  assert.equal(breakerAllows("groq"), false, "half-open failure re-opens");
  now += 30_000;
  assert.equal(breakerAllows("groq"), false, "hold doubled to 60s");
  now += 30_000;
  assert.equal(breakerAllows("groq"), true);
  recordProviderSuccess("groq");
  recordProviderFailure("groq");
  assert.equal(breakerAllows("groq"), true, "success resets the count");
  __setBreakerNow(() => Date.now());
  reset();
});

test("only transport errors, 408 and 5xx are provider-level", () => {
  assert.equal(isProviderLevelFailure(null), true);
  assert.equal(isProviderLevelFailure(408), true);
  assert.equal(isProviderLevelFailure(503), true);
  assert.equal(isProviderLevelFailure(429), false);
  assert.equal(isProviderLevelFailure(402), false);
  assert.equal(isProviderLevelFailure(401), false);
});

test("an open breaker removes every model of that provider from the chain", async () => {
  reset();
  let settings = setProviderKey(emptySettings(), "groq", "gsk");
  settings = setProviderKey(settings, "open_router", "or");
  settings.model = "groq/llama-3.3-70b-versatile";
  settings.fallbacks = ["groq/llama-3.1-8b-instant", "open_router/openrouter/free"];
  const hits: string[] = [];
  const transport = async (attempt: RouteAttempt): Promise<Response> => {
    hits.push(attempt.ref.slug);
    if (attempt.ref.providerId === "groq") return new Response("down", { status: 503 });
    return new Response(JSON.stringify({ choices: [] }), { status: 200 });
  };
  const body: ChatRequest = { model: "free-opencode/default", stream: false };
  for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i += 1) {
    __resetCooldowns(); // isolate the breaker from per-slug cooldowns
    await routeChat(settings, body, transport);
  }
  __resetCooldowns();
  hits.length = 0;
  const result = await routeChat(settings, body, transport);
  assert.equal(result.used.providerId, "open_router");
  assert.deepEqual(hits, ["open_router/openrouter/free"], "no groq model is tried");
  reset();
});

test("a 429 on one key rotates to the same model on the next account", async () => {
  reset();
  let settings = setProviderKey(emptySettings(), "groq", "gsk_one");
  settings = addAccount(settings, "groq", "a2").settings;
  settings = setProviderKey(settings, "groq@a2", "gsk_two");
  settings.model = "groq/llama-3.3-70b-versatile";
  settings.fallbacks = ["groq/llama-3.3-70b-versatile"];
  const slugs = routeTargets(settings, "groq/llama-3.3-70b-versatile").map((t) => t.slug);
  assert.deepEqual(slugs.slice(0, 2), [
    "groq/llama-3.3-70b-versatile",
    "groq@a2/llama-3.3-70b-versatile",
  ]);
  const keys: string[] = [];
  const result = await routeChat(
    settings,
    { model: "groq/llama-3.3-70b-versatile", stream: false },
    async (attempt) => {
      keys.push(attempt.apiKey);
      if (attempt.apiKey === "gsk_one") return new Response("{}", { status: 429 });
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    }
  );
  assert.equal(result.used.providerId, "groq@a2");
  assert.deepEqual(keys, ["gsk_one", "gsk_two"]);
  reset();
});

test("auto/fast orders a tier by measured latency without leaving it", () => {
  reset();
  let settings = setProviderKey(emptySettings(), "open_router", "or");
  settings = setProviderKey(settings, "groq", "gsk");
  settings.model = "open_router/openrouter/free";
  settings.fallbacks = ["open_router/stealth/union-alpha", "groq/llama-3.3-70b-versatile"];
  const plain = routeTargets(settings, "default").map((t) => t.slug);
  recordLatency("open_router/stealth/union-alpha", 100);
  recordLatency("open_router/openrouter/free", 900);
  recordLatency("groq/llama-3.3-70b-versatile", 10);
  const fast = routeTargets(settings, "auto/fast").map((t) => t.slug);
  assert.deepEqual(new Set(fast), new Set(plain), "same candidates");
  assert.ok(
    fast.indexOf("open_router/stealth/union-alpha") < fast.indexOf("open_router/openrouter/free")
  );
  // groq is paid here: fastest overall, but it stays behind every free model.
  const freeCount = plain.filter((s) => s.startsWith("open_router/")).length;
  assert.ok(fast.indexOf("groq/llama-3.3-70b-versatile") >= freeCount);
  reset();
});

test("auto/sticky pins the last model that answered", () => {
  reset();
  const settings = setProviderKey(emptySettings(), "open_router", "or");
  settings.model = "open_router/openrouter/free";
  settings.fallbacks = ["open_router/stealth/union-alpha"];
  recordSuccess("open_router/stealth/union-alpha", 10);
  const sticky = routeTargets(settings, "auto/sticky").map((t) => t.slug);
  assert.equal(sticky[0], "open_router/stealth/union-alpha");
  reset();
});

test("learned context limits skip models that already overflowed at this size", () => {
  reset();
  const big = MIN_LEARNED_CONTEXT_CHARS * 2;
  recordContextOverflow("p/m", 10);
  assert.equal(fitsContext("p/m", 1_000_000), true, "tiny overflows teach nothing");
  recordContextOverflow("p/m", big);
  assert.equal(fitsContext("p/m", big), false);
  assert.equal(fitsContext("p/m", big - 1), true);
  recordSuccess("p/m", big + 5);
  assert.equal(fitsContext("p/m", big), true, "a larger success clears the limit");
  reset();
});

test("compaction trims huge tool output, dedups repeats, leaves other roles alone", () => {
  const log = "x".repeat(50_000);
  const repeated = "same result ".repeat(100);
  const messages = [
    { role: "user", content: log },
    { role: "tool", tool_call_id: "c1", content: log },
    { role: "tool", tool_call_id: "c2", content: repeated },
    { role: "tool", tool_call_id: "c3", content: repeated },
    { role: "tool", tool_call_id: "c4", content: [{ type: "image_url", image_url: "…" }] },
  ];
  const { messages: out, report } = compactMessages(messages);
  const rows = out as Array<{ content: unknown }>;
  assert.equal(rows[0].content, log, "user text untouched");
  assert.ok((rows[1].content as string).length < 33_000);
  assert.match(rows[1].content as string, /chars omitted by free-opencode/);
  assert.equal(rows[2].content, repeated, "first occurrence kept");
  assert.match(rows[3].content as string, /identical to the earlier tool result c2/);
  assert.deepEqual(rows[4], messages[4], "non-text parts untouched");
  assert.equal(report.trimmed, 1);
  assert.equal(report.deduped, 1);
  // Deterministic: a second pass over the same input gives the same output.
  assert.deepEqual(compactMessages(messages).messages, out);
});

test("compaction can be turned off per request", () => {
  assert.equal(compactionMode("off"), "off");
  assert.equal(compactionMode(undefined), "safe");
  const messages = [{ role: "tool", content: "y".repeat(100_000) }];
  assert.deepEqual(
    compactMessages(messages, { mode: "off", maxToolChars: 10, minDedupChars: 1 }).messages,
    messages
  );
  assert.equal(trimHeadTail("short", 100), "short");
});

test("routeChat sends compacted messages upstream", async () => {
  reset();
  const settings = setProviderKey(emptySettings(), "groq", "gsk");
  let sent = 0;
  const result = await routeChat(
    settings,
    {
      model: "groq/llama-3.3-70b-versatile",
      stream: false,
      messages: [{ role: "tool", content: "z".repeat(100_000) }],
    },
    async (_attempt, body) => {
      sent = JSON.stringify(body.messages).length;
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    }
  );
  assert.ok(sent < 40_000);
  assert.ok(result.compaction.savedChars > 60_000);
  reset();
});

test("SettingsStore merges learned access without reverting concurrent edits", () => {
  const store = new SettingsStore(emptySettings());
  store.update((s) => ({ ...s, model: "groq/new-default" }));
  store.learnAccess({ "bai/x": { status: "open", checkedAt: 1 } as never });
  assert.equal(store.get().model, "groq/new-default");
  assert.ok(store.get().modelAccess["bai/x"]);
});
