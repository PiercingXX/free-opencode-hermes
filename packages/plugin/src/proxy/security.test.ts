import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

import { emptySettings, saveSettings, setProviderKey } from "../config/settings.js";
import { isAllowedHostname } from "./http.js";
import { startProxy, waitForListen, type RunningProxy } from "./server.js";

type RawResponse = { status: number; body: string };

/** node:http so tests can forge Host / Origin, which fetch() refuses to set. */
function raw(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function withProxy(fn: (proxy: RunningProxy, port: number) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "foc-security-"));
  const settings = setProviderKey(emptySettings(), "groq", "gsk_secret_key");
  settings.listen = { host: "127.0.0.1", port: 0 };
  saveSettings(settings, home);
  const proxy = startProxy(settings, home);
  await waitForListen(proxy);
  try {
    await fn(proxy, (proxy.server.address() as AddressInfo).port);
  } finally {
    await proxy.close();
  }
}

test("isAllowedHostname accepts local names and IP literals, rejects domains", () => {
  assert.equal(isAllowedHostname("localhost", "127.0.0.1"), true);
  assert.equal(isAllowedHostname("app.localhost", "127.0.0.1"), true);
  assert.equal(isAllowedHostname("127.0.0.1", "127.0.0.1"), true);
  assert.equal(isAllowedHostname("100.64.0.7", "127.0.0.1"), true);
  assert.equal(isAllowedHostname("::1", "127.0.0.1"), true);
  assert.equal(isAllowedHostname("evil.example", "127.0.0.1"), false);
  assert.equal(isAllowedHostname("box.tailnet.ts.net", "box.tailnet.ts.net"), true);
});

test("admin API requires the admin token or the proxy token", async () => {
  await withProxy(async (proxy, port) => {
    assert.equal((await raw(port, "/admin/api/state")).status, 401);
    const withToken = await raw(port, "/admin/api/state", {
      headers: { "x-foc-admin": proxy.adminToken },
    });
    assert.equal(withToken.status, 200);
    const withBearer = await raw(port, "/admin/api/state", {
      headers: { Authorization: `Bearer ${proxy.settings().proxyAuthToken}` },
    });
    assert.equal(withBearer.status, 200);
    // The page itself is public (to loopback) and carries the token.
    const page = await raw(port, "/admin");
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(proxy.adminToken));
  });
});

test("cross-site POST cannot reach admin or the chat relay", async () => {
  await withProxy(async (proxy, port) => {
    const evilProbe = JSON.stringify({ providerId: "groq", extra: { baseUrl: "https://evil" } });
    // Browser "simple request": text/plain, foreign Origin, no custom headers.
    const csrf = await raw(port, "/admin/api/probe", {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: "https://evil.example" },
      body: evilProbe,
    });
    assert.equal(csrf.status, 403);
    // Even with the token, a non-JSON body is refused.
    const plain = await raw(port, "/admin/api/probe", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "x-foc-admin": proxy.adminToken },
      body: evilProbe,
    });
    assert.equal(plain.status, 415);
    const relay = await raw(port, "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: "https://evil.example" },
      body: JSON.stringify({ model: "groq/x", messages: [] }),
    });
    assert.equal(relay.status, 403);
    const relayNoOrigin = await raw(port, "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ model: "groq/x", messages: [] }),
    });
    assert.equal(relayNoOrigin.status, 415);
  });
});

test("DNS-rebound Host header is rejected everywhere", async () => {
  await withProxy(async (proxy, port) => {
    for (const path of ["/admin", "/admin/api/state", "/v1/models", "/health"]) {
      const res = await raw(port, path, {
        headers: { Host: `rebind.evil.example:${port}`, "x-foc-admin": proxy.adminToken },
      });
      assert.equal(res.status, 403, path);
    }
    const local = await raw(port, "/health", { headers: { Host: `localhost:${port}` } });
    assert.equal(local.status, 200);
  });
});

test("oversized admin bodies are rejected with 413", async () => {
  await withProxy(async (proxy, port) => {
    const res = await raw(port, "/admin/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-foc-admin": proxy.adminToken },
      body: JSON.stringify({ model: "x".repeat(2 * 1024 * 1024) }),
    });
    assert.equal(res.status, 413);
  });
});

test("API keys never appear in admin state", async () => {
  await withProxy(async (proxy, port) => {
    const res = await raw(port, "/admin/api/state", {
      headers: { "x-foc-admin": proxy.adminToken },
    });
    assert.equal(res.status, 200);
    assert.ok(!res.body.includes("gsk_secret_key"));
  });
});
