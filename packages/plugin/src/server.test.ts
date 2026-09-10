import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

import { connectProvider, emptySettings, saveSettings, setProviderKey } from "./config/settings.js";
import { startProxy, waitForListen } from "./proxy/server.js";
import { logRoute } from "./proxy/route-log.js";
import { __resetCooldowns, recordCooldown } from "./proxy/cooldown.js";

test("proxy health and models endpoints", async () => {
  const home = mkdtempSync(join(tmpdir(), "foc-proxy-"));
  const settings = setProviderKey(emptySettings(), "groq", "gsk_test");
  settings.listen = { host: "127.0.0.1", port: 0 };
  settings.proxyAuthEnabled = true;
  saveSettings(settings, home);

  const proxy = startProxy(settings, home);
  await waitForListen(proxy);
  const addr = proxy.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const admin = await fetch(`${base}/admin`);
    assert.equal(admin.status, 200);
    const html = await admin.text();
    assert.match(html, /Free OpenCode &amp; Hermes by PiercingXX/);
    assert.match(html, /by PiercingXX/);
    assert.match(html, /--pxx-ink/);
    assert.doesNotMatch(html, /href="https:\/\/github.com\/PiercingXX\/piercingxx-branding"/);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const healthBody = (await health.json()) as { ok: boolean; builtAt?: number };
    assert.equal(healthBody.ok, true);
    assert.equal(typeof healthBody.builtAt, "number");
    const models = await fetch(`${base}/v1/models?view=responses`, {
      headers: { Authorization: `Bearer ${settings.proxyAuthToken}` },
    });
    assert.equal(models.status, 200);
    const body = (await models.json()) as {
      data: Array<{
        id: string;
        provider_model_ref?: string;
        apiBackend?: string;
        supportsReasoning?: boolean;
        supportsTools?: boolean;
      }>;
      first_id: string | null;
    };
    assert.ok(body.data.some((row) => row.id.startsWith("groq/")));
    const groq = body.data.find((row) => row.id.startsWith("groq/"));
    assert.ok(groq);
    assert.equal(groq.provider_model_ref, groq.id);
    assert.equal(groq.apiBackend, "responses");
    assert.equal(groq.supportsReasoning, true);
    assert.equal(groq.supportsTools, true);
    assert.ok(body.first_id);
    const loopback = await fetch(`${base}/v1/models`);
    assert.equal(loopback.status, 200);
    const wrong = await fetch(`${base}/v1/models`, {
      headers: { Authorization: "Bearer " + "x".repeat(settings.proxyAuthToken.length) },
    });
    assert.equal(wrong.status, 401);
    const state = await fetch(`${base}/admin/api/state`);
    assert.equal(state.status, 200);
    const payload = (await state.json()) as {
      catalog: Array<{
        id: string;
        ready?: boolean;
        extra: Array<{ key: string; placeholder: string; value: string }>;
      }>;
    };
    const ollama = payload.catalog.find((row) => row.id === "ollama");
    assert.ok(ollama);
    const baseUrl = ollama.extra.find((field) => field.key === "baseUrl");
    assert.ok(baseUrl);
    assert.equal(baseUrl.placeholder.includes("11434"), true);
    assert.equal(baseUrl.value, "");
    assert.equal(ollama.ready, false);
    assert.ok(payload.catalog.find((row) => row.id === "sglang"));
    assert.ok(payload.catalog.find((row) => row.id === "tailscale_sglang"));
    assert.ok(payload.catalog.find((row) => row.id === "tailscale_ollama"));
    const probe = await fetch(`${base}/admin/api/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "ollama", extra: { baseUrl: "http://127.0.0.1:9/v1" } }),
    });
    assert.equal(probe.status, 200);
    const probed = (await probe.json()) as { ok: boolean; error?: string };
    assert.equal(probed.ok, false);
    assert.ok(probed.error);
    const connectFail = await fetch(`${base}/admin/api/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "ollama", extra: { baseUrl: "http://127.0.0.1:9/v1" } }),
    });
    assert.equal(connectFail.status, 200);
    const connectedFail = (await connectFail.json()) as { ok: boolean; saved?: boolean };
    assert.equal(connectedFail.ok, false);
    assert.equal(connectedFail.saved, undefined);

    const removed = await fetch(`${base}/admin/api/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "groq" }),
    });
    assert.equal(removed.status, 200);
    const removedBody = (await removed.json()) as { ok: boolean; providerId: string };
    assert.equal(removedBody.ok, true);
    assert.equal(removedBody.providerId, "groq");
    const after = await fetch(`${base}/admin/api/state`);
    const afterPayload = (await after.json()) as {
      catalog: Array<{ id: string; ready?: boolean; configured?: boolean }>;
    };
    const groqAfter = afterPayload.catalog.find((row) => row.id === "groq");
    assert.ok(groqAfter);
    assert.equal(groqAfter.ready, false);
    assert.equal(groqAfter.configured, false);
  } finally {
    await proxy.close();
  }
});

test("remove local providers hides cards and Apply does not restore them", async () => {
  const home = mkdtempSync(join(tmpdir(), "foc-proxy-remove-"));
  const settings = connectProvider(
    emptySettings(),
    "ollama",
    { baseUrl: "http://127.0.0.1:9/v1" },
    ["qwen2.5-coder:14b"]
  );
  settings.listen = { host: "127.0.0.1", port: 0 };
  settings.proxyAuthEnabled = true;
  saveSettings(settings, home);
  const proxy = startProxy(settings, home);
  await waitForListen(proxy);
  const addr = proxy.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const before = await fetch(`${base}/admin/api/state`);
    const beforePayload = (await before.json()) as {
      catalog: Array<{ id: string; ready?: boolean }>;
      models: Array<{ id: string }>;
    };
    assert.equal(beforePayload.catalog.find((row) => row.id === "ollama")?.ready, true);
    assert.ok(beforePayload.models.some((row) => row.id.startsWith("ollama/")));

    const removed = await fetch(`${base}/admin/api/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "ollama" }),
    });
    assert.equal(removed.status, 200);

    const afterRemove = await fetch(`${base}/admin/api/state`);
    const afterRemovePayload = (await afterRemove.json()) as {
      catalog: Array<{ id: string }>;
      models: Array<{ id: string }>;
    };
    assert.equal(
      afterRemovePayload.catalog.find((row) => row.id === "ollama"),
      undefined
    );
    assert.equal(
      afterRemovePayload.models.some((row) => row.id.startsWith("ollama/")),
      false
    );

    const applied = await fetch(`${base}/admin/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extra: { ollama: { baseUrl: "http://127.0.0.1:11434/v1" } },
      }),
    });
    assert.equal(applied.status, 200);

    const afterApply = await fetch(`${base}/admin/api/state`);
    const afterApplyPayload = (await afterApply.json()) as {
      catalog: Array<{ id: string }>;
      models: Array<{ id: string }>;
    };
    assert.equal(
      afterApplyPayload.catalog.find((row) => row.id === "ollama"),
      undefined
    );
    assert.equal(
      afterApplyPayload.models.some((row) => row.id.startsWith("ollama/")),
      false
    );
  } finally {
    await proxy.close();
  }
});

test("admin state and health expose lastRoute after a recorded hop", async () => {
  const home = mkdtempSync(join(tmpdir(), "foc-proxy-lastroute-"));
  const settings = setProviderKey(emptySettings(), "groq", "gsk_test");
  settings.listen = { host: "127.0.0.1", port: 0 };
  settings.proxyAuthEnabled = true;
  saveSettings(settings, home);
  const proxy = startProxy(settings, home);
  await waitForListen(proxy);
  const addr = proxy.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    await logRoute(
      home,
      {
        at: new Date().toISOString(),
        slug: "groq/llama-3.3-70b-versatile",
        providerId: "groq",
        status: 200,
        latencyMs: 33,
        ok: true,
        fallback: false,
        tried: ["groq/llama-3.3-70b-versatile", "open_router/openrouter/free"],
      },
      "route.result"
    );
    const state = await fetch(`${base}/admin/api/state`);
    const body = (await state.json()) as {
      lastRoute: { slug: string; status: number; tried: string[] };
    };
    assert.ok(body.lastRoute);
    assert.equal(body.lastRoute.slug, "groq/llama-3.3-70b-versatile");
    assert.equal(body.lastRoute.status, 200);
    assert.deepEqual(body.lastRoute.tried, [
      "groq/llama-3.3-70b-versatile",
      "open_router/openrouter/free",
    ]);

    const health = await fetch(`${base}/health`);
    const healthBody = (await health.json()) as { lastRoute: { slug: string } };
    assert.equal(healthBody.lastRoute.slug, "groq/llama-3.3-70b-versatile");

    const lastRoute = await fetch(`${base}/admin/api/last-route`);
    const lastRouteBody = (await lastRoute.json()) as {
      lastRoute: { slug: string };
      recent: unknown[];
    };
    assert.equal(lastRouteBody.lastRoute.slug, "groq/llama-3.3-70b-versatile");
    assert.ok(lastRouteBody.recent.length >= 1);
  } finally {
    await proxy.close();
  }
});

test("admin state and health surface active cooldowns", async () => {
  const home = mkdtempSync(join(tmpdir(), "foc-proxy-cooldown-"));
  const settings = setProviderKey(emptySettings(), "groq", "gsk_test");
  settings.listen = { host: "127.0.0.1", port: 0 };
  settings.proxyAuthEnabled = true;
  saveSettings(settings, home);
  const proxy = startProxy(settings, home);
  await waitForListen(proxy);
  const addr = proxy.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    __resetCooldowns();
    recordCooldown("open_router/openrouter/free", "open_router", {
      status: 429,
      retryAfter: 60_000,
    });
    const state = await fetch(`${base}/admin/api/state`);
    const body = (await state.json()) as {
      cooldowns: Array<{ slug: string; availableAt: number }>;
    };
    assert.equal(body.cooldowns.length, 1);
    assert.equal(body.cooldowns[0].slug, "open_router/openrouter/free");
    assert.equal(typeof body.cooldowns[0].availableAt, "number");

    const health = await fetch(`${base}/health`);
    const healthBody = (await health.json()) as { cooldowns: Array<{ slug: string }> };
    assert.ok(healthBody.cooldowns.some((c) => c.slug === "open_router/openrouter/free"));
  } finally {
    await proxy.close();
    __resetCooldowns();
  }
});
