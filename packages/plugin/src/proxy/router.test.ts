import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  connectProvider,
  emptySettings,
  setProviderKey,
  saveSettings,
} from "../config/settings.js";
import { __resetCooldowns, __setNow, cooldownAvailableAt, recordCooldown } from "./cooldown.js";
import {
  isRetryableStatus,
  isSelfHostedProvider,
  routeChat,
  routeTargets,
  type ChatRequest,
  type RouteAttempt,
} from "./router.js";

test("isSelfHostedProvider flags local and Tailscale boxes but not cloud", () => {
  assert.equal(isSelfHostedProvider("ollama"), true);
  assert.equal(isSelfHostedProvider("sglang"), true);
  assert.equal(isSelfHostedProvider("lmstudio"), true);
  assert.equal(isSelfHostedProvider("llamacpp"), true);
  assert.equal(isSelfHostedProvider("tailscale_ollama"), true);
  assert.equal(isSelfHostedProvider("tailscale_sglang"), true);
  assert.equal(isSelfHostedProvider("open_router"), false);
  assert.equal(isSelfHostedProvider("groq"), false);
  assert.equal(isSelfHostedProvider("nvidia_nim"), false);
});

test("alias route: free OpenRouter first, paid cloud, self-hosted last", () => {
  __resetCooldowns();
  // Admin default is a local Tailscale SGLang box — that must be last-resort.
  let settings = connectProvider(
    emptySettings(),
    "tailscale_sglang",
    { baseUrl: "http://valkyrie:30000/v1" },
    ["deepseek-v4-flash"]
  );
  settings.model = "tailscale_sglang/deepseek-v4-flash";
  settings = setProviderKey(settings, "open_router", "or_test");
  settings = setProviderKey(settings, "groq", "gsk_test");

  const targets = routeTargets(settings, "free-opencode/default");
  const slugs = targets.map((t) => t.slug);
  assert.ok(slugs.length >= 4);

  // Free OpenRouter models rank before the paid Groq box and the Tailscale GPU box.
  const freeIdx = slugs.indexOf("open_router/openrouter/free");
  assert.ok(freeIdx >= 0, "OpenRouter :free should be in the candidate list");
  const localIdx = slugs.indexOf("tailscale_sglang/deepseek-v4-flash");
  assert.ok(localIdx >= 0, "self-hosted default should still be a candidate");
  assert.ok(freeIdx < localIdx, "free cloud must precede self-hosted");
  assert.ok(slugs.indexOf("groq/llama-3.3-70b-versatile") < localIdx, "cloud precedes self-hosted");
  // Self-hosted is the very last bucket.
  assert.equal(localIdx, slugs.length - 1);
});

test("alias route: paid Admin default with empty fallbacks still tries free OpenRouter first", () => {
  __resetCooldowns();
  // Admin default is a PAID NIM model and the fallback list is empty. A
  // connected OpenRouter free model must still rank before that paid default
  // on catalog-alias traffic; self-hosted stays last.
  let settings = connectProvider(
    emptySettings(),
    "tailscale_sglang",
    { baseUrl: "http://valkyrie:30000/v1" },
    ["deepseek-v4-flash"]
  );
  settings.model = "nvidia_nim/nvidia/nemotron-3-super-120b-a12b";
  settings.fallbacks = [];
  settings = setProviderKey(settings, "open_router", "or_test");
  settings = setProviderKey(settings, "nvidia_nim", "nim_test");

  const targets = routeTargets(settings, "free-opencode/default");
  const slugs = targets.map((t) => t.slug);
  const freeIdx = slugs.indexOf("open_router/openrouter/free");
  assert.ok(freeIdx >= 0, "connected OpenRouter :free should participate");
  const nimIdx = slugs.indexOf("nvidia_nim/nvidia/nemotron-3-super-120b-a12b");
  assert.ok(nimIdx >= 0);
  assert.ok(freeIdx < nimIdx, "free cloud precedes a paid Admin default even with no fallbacks");
  const localIdx = slugs.indexOf("tailscale_sglang/deepseek-v4-flash");
  assert.ok(localIdx >= 0);
  assert.equal(localIdx, slugs.length - 1, "self-hosted stays last");
});

test("explicit concrete local slug stays first and is never rewritten", async () => {
  __resetCooldowns();
  let settings = connectProvider(
    emptySettings(),
    "tailscale_sglang",
    { baseUrl: "http://valkyrie:30000/v1" },
    ["deepseek-v4-flash"]
  );
  settings.model = "tailscale_sglang/deepseek-v4-flash";
  settings = setProviderKey(settings, "open_router", "or_test");

  // Explicit local request → that slug first, then cloud.
  const targets = routeTargets(settings, "tailscale_sglang/deepseek-v4-flash");
  assert.equal(targets[0].slug, "tailscale_sglang/deepseek-v4-flash");

  const hits: string[] = [];
  const result = await routeChat(
    settings,
    { model: "tailscale_sglang/deepseek-v4-flash", stream: false } satisfies ChatRequest,
    async (attempt: RouteAttempt) => {
      hits.push(attempt.ref.slug);
      return new Response(JSON.stringify({ id: "ok", choices: [] }), { status: 200 });
    }
  );
  assert.equal(result.used.slug, "tailscale_sglang/deepseek-v4-flash");
  assert.equal(hits[0], "tailscale_sglang/deepseek-v4-flash");
});

test("429 with Retry-After skips that slug until it reinstates after expiry", async () => {
  __resetCooldowns();
  let settings = setProviderKey(emptySettings(), "open_router", "or_test");
  settings.model = "open_router/openrouter/free";
  settings = setProviderKey(settings, "tailscale_sglang", "local");

  // Prime a cooldown that ends at t=1000ms.
  const start = 0;
  __setNow(() => start);
  recordCooldown("open_router/openrouter/free", "open_router", {
    status: 429,
    retryAfter: 60_000,
  });

  // While cooled down, the free slug is skipped entirely.
  const cooled = routeTargets(settings, "free-opencode/default").map((t) => t.slug);
  assert.ok(!cooled.includes("open_router/openrouter/free"));

  // Time travel past the window → eligible again (recheck by using).
  __setNow(() => start + 61_000);
  const back = routeTargets(settings, "free-opencode/default").map((t) => t.slug);
  assert.ok(back.includes("open_router/openrouter/free"));
  __resetCooldowns();
});

test("402 insufficient credits skips remaining paid slugs on that provider and uses last-resort", async () => {
  __resetCooldowns();
  let settings = connectProvider(
    emptySettings(),
    "tailscale_sglang",
    { baseUrl: "http://valkyrie:30000/v1" },
    ["deepseek-v4-flash"]
  );
  settings.model = "tailscale_sglang/deepseek-v4-flash";
  settings = setProviderKey(settings, "open_router", "or_test");

  const result = await routeChat(
    settings,
    { model: "free-opencode/default", stream: false } satisfies ChatRequest,
    async (attempt: RouteAttempt) => {
      if (attempt.ref.providerId === "open_router") {
        return new Response(
          JSON.stringify({
            error: {
              message: "Insufficient credits. This account never purchased credits.",
              type: "payment_required",
            },
          }),
          { status: 402 }
        );
      }
      return new Response(JSON.stringify({ id: "ok", choices: [] }), { status: 200 });
    }
  );
  assert.equal(result.used.providerId, "tailscale_sglang");
  assert.ok(result.tried.some((slug) => slug.startsWith("open_router/")));
  assert.ok(result.tried.includes("tailscale_sglang/deepseek-v4-flash"));
  // One 402 on a paid OpenRouter slug is enough; we do not walk every paid id.
  const paidHits = result.tried.filter((slug) => slug.startsWith("open_router/")).length;
  assert.ok(paidHits >= 1);
  assert.equal(isRetryableStatus(402), true, "402 must not abort the chain");
  __resetCooldowns();
});

test("routeChat records a cooldown from a retryable upstream and answers the fallback", async () => {
  __resetCooldowns();
  let settings = connectProvider(
    emptySettings(),
    "tailscale_sglang",
    { baseUrl: "http://valkyrie:30000/v1" },
    ["deepseek-v4-flash"]
  );
  settings.model = "tailscale_sglang/deepseek-v4-flash";
  settings = setProviderKey(settings, "open_router", "or_test");

  const home = mkdtempSync(join(tmpdir(), "foc-router-"));
  saveSettings(settings, home);

  // Free OpenRouter defines the flow; local is the last-resort answer.
  __resetCooldowns();
  const result = await routeChat(
    settings,
    { model: "free-opencode/default", stream: false } satisfies ChatRequest,
    async (attempt: RouteAttempt) => {
      if (attempt.ref.providerId === "open_router") {
        return new Response(
          JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }),
          { status: 429, headers: { "retry-after": "45" } }
        );
      }
      return new Response(JSON.stringify({ id: "ok", choices: [] }), { status: 200 });
    },
    undefined,
    undefined
  );
  assert.equal(result.used.providerId, "tailscale_sglang");

  // The 429'd free slug is now in cooldown, so the next alias route skips it.
  const next = routeTargets(settings, "free-opencode/default").map((t) => t.slug);
  assert.ok(
    !next.includes("open_router/openrouter/free"),
    "cooldowned free slug is skipped next turn"
  );
  __resetCooldowns();
});

test("routeChat repeat 429 without Retry-After doubles the cooldown backoff", async () => {
  __resetCooldowns();
  // Fixed clock so the backoff timeline is deterministic.
  let nowMs = 0;
  __setNow(() => nowMs);
  let settings = connectProvider(
    emptySettings(),
    "tailscale_sglang",
    { baseUrl: "http://valkyrie:30000/v1" },
    ["deepseek-v4-flash"]
  );
  // Explicit free model; local SGLang is the last-resort answer that keeps both
  // routeChat calls from throwing.
  settings.model = "open_router/openrouter/free";
  settings = setProviderKey(settings, "open_router", "or_test");
  const home = mkdtempSync(join(tmpdir(), "foc-router-backoff-"));
  saveSettings(settings, home);

  const transport = async (attempt: RouteAttempt): Promise<Response> => {
    if (attempt.ref.providerId === "open_router") {
      // No Retry-After header; `reason` is the upstream message, not a token.
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
      });
    }
    return new Response(JSON.stringify({ id: "ok", choices: [] }), { status: 200 });
  };

  const request = { model: "open_router/openrouter/free", stream: false } satisfies ChatRequest;

  // First 429 cools the slug down for the default 60s.
  await routeChat(settings, request, transport, undefined, undefined, home);
  assert.equal(cooldownAvailableAt("open_router/openrouter/free"), 60_000);

  // Fast-forward past the first window so the slug is eligible again (recheck).
  nowMs = 61_000;
  await routeChat(settings, request, transport, undefined, undefined, home);
  // A second 429 with no Retry-After doubles the previous backoff → 120s.
  assert.equal(cooldownAvailableAt("open_router/openrouter/free"), 61_000 + 120_000);
  __resetCooldowns();
});
