import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { logPath } from "../paths.js";
import { emptySettings, setProviderKey } from "../config/settings.js";
import {
  appendLog,
  formatRouteLine,
  __setMaxLogBytes,
  __resetRouteLog,
  currentLastRoute,
  logRoute,
  readLogTail,
  recentRoutes,
  type RouteHopRecord,
} from "./route-log.js";
import { routeChat, type ChatRequest, type RouteAttempt, type RouteHopInfo } from "./router.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "foc-log-"));
}

test("formatRouteLine tags local vs cloud hops", () => {
  const cloud: RouteHopRecord = {
    at: new Date().toISOString(),
    slug: "open_router/openrouter/free",
    providerId: "open_router",
    status: 200,
    latencyMs: 12,
    ok: true,
    fallback: false,
    tried: ["open_router/openrouter/free"],
  };
  const local: RouteHopRecord = {
    ...cloud,
    slug: "tailscale_sglang/deepseek-v4-flash",
    providerId: "tailscale_sglang",
  };
  assert.match(formatRouteLine(cloud, { providerName: "OpenRouter" }), /^CLOUD /);
  assert.match(
    formatRouteLine(local, { local: true, providerName: "Tailscale SGLang" }),
    /^LOCAL /
  );
  assert.ok(formatRouteLine(local, { local: true }).includes("tailscale_sglang/deepseek-v4-flash"));
});

test("logRoute appends JSONL lines and never writes key material", async () => {
  const home = tempHome();
  await logRoute(
    home,
    {
      at: new Date().toISOString(),
      slug: "groq/llama-3.3-70b-versatile",
      providerId: "groq",
      status: 200,
      latencyMs: 42,
      ok: true,
      fallback: false,
      tried: ["groq/llama-3.3-70b-versatile"],
    },
    "route.attempt"
  );
  await appendLog(
    "proxy.start",
    { pid: 123, apiKey: "sk-supersecretvalue", Authorization: "Bearer sk-othersecret" },
    home
  );

  const raw = readFileSync(logPath(home), "utf8");
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('"type":"route.attempt"'));
  assert.ok(!raw.includes("sk-supersecretvalue"));
  assert.ok(!raw.includes("sk-othersecret"));
});

test("rotation moves an oversized log to .1", async () => {
  const home = tempHome();
  // Write one line, then shrink the threshold so the next write rotates.
  await appendLog("route.attempt", { n: 1 }, home);
  __setMaxLogBytes(10);
  await appendLog("route.attempt", { n: 2 }, home);

  assert.ok(existsSync(`${logPath(home)}.1`), "oversized log should rotate to .1");
  const rotated = readFileSync(`${logPath(home)}.1`, "utf8");
  assert.ok(rotated.includes('"n":1'));
  const current = readFileSync(logPath(home), "utf8");
  assert.ok(current.includes('"n":2'));
});

test("lastRoute and recentRoutes track the latest hop", async () => {
  __resetRouteLog();
  const home = tempHome();
  await logRoute(
    home,
    {
      at: new Date().toISOString(),
      slug: "groq/a",
      providerId: "groq",
      status: 429,
      latencyMs: 10,
      ok: false,
      fallback: false,
      tried: ["groq/a", "open_router/b"],
    },
    "route.attempt"
  );
  const route: RouteHopRecord = {
    at: new Date().toISOString(),
    slug: "open_router/b",
    providerId: "open_router",
    status: 200,
    latencyMs: 20,
    ok: true,
    fallback: 1,
    tried: ["groq/a", "open_router/b"],
  };
  await logRoute(home, route, "route.result");

  const last = currentLastRoute();
  assert.ok(last);
  assert.equal(last.slug, "open_router/b");
  assert.deepEqual(last.tried, ["groq/a", "open_router/b"]);
  assert.equal(last.fallback, 1);
  const recent = recentRoutes();
  assert.equal(recent[0].slug, "open_router/b");
  // Only the final route.result lands in the ring — the earlier attempt above is
  // on-disk only, so one request never double-counts the same hop.
  assert.equal(recent.length, 1);
});

test("readLogTail returns parsed records with secrets redacted", async () => {
  const home = tempHome();
  await appendLog("test", { message: "sk-leak1234567", auth: "Bearer tokensecret123" }, home);
  const tail = await readLogTail(10, home);
  assert.equal(tail.length, 1);
  assert.ok(!JSON.stringify(tail[0]).includes("sk-leak1234567"));
  assert.ok(!JSON.stringify(tail[0]).includes("tokensecret123"));
});

test("routeChat emits hops for retryable fallback with the full tried chain", async () => {
  const settings = setProviderKey(emptySettings(), "groq", "k1");
  const withFallback = setProviderKey(settings, "open_router", "k2");
  withFallback.model = "groq/llama-3.3-70b-versatile";
  withFallback.fallbacks = ["open_router/openrouter/free"];

  const hops: RouteHopInfo[] = [];
  const result = await routeChat(
    withFallback,
    { model: "groq/llama-3.3-70b-versatile", stream: false } satisfies ChatRequest,
    async (attempt: RouteAttempt) => {
      if (attempt.ref.providerId === "groq") {
        return new Response(JSON.stringify({ error: { message: "nope" } }), { status: 429 });
      }
      return new Response(JSON.stringify({ id: "ok", choices: [] }), { status: 200 });
    },
    undefined,
    (hop) => hops.push(hop)
  );

  assert.equal(result.used.providerId, "open_router");
  assert.equal(hops.length, 2);
  assert.equal(hops[0].ok, false);
  assert.equal(hops[0].status, 429);
  assert.equal(hops[0].fallback, false);
  assert.deepEqual(hops[0].tried, ["groq/llama-3.3-70b-versatile", "open_router/openrouter/free"]);
  assert.equal(hops[1].ok, true);
  assert.equal(hops[1].fallback, 1);
  assert.deepEqual(hops[1].tried, ["groq/llama-3.3-70b-versatile", "open_router/openrouter/free"]);
});
