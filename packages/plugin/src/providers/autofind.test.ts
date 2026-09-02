import assert from "node:assert/strict";
import test from "node:test";

import { emptySettings, isProviderReady, removeProvider } from "../config/settings.js";
import {
  applyAutofindResults,
  assignProviderId,
  lanHostsFromArpTable,
  runAutofind,
  scopeForHost,
  type AutofindHit,
} from "./autofind.js";

test("scopeForHost classifies loopback, tailscale, and lan", () => {
  assert.equal(scopeForHost("127.0.0.1"), "loopback");
  assert.equal(scopeForHost("100.64.1.8"), "tailscale");
  assert.equal(scopeForHost("192.168.1.20"), "lan");
});

test("assignProviderId fills canonical slots then unique extras", () => {
  const used = new Set<string>();
  const localOllama: AutofindHit = {
    scope: "loopback",
    host: "127.0.0.1",
    kind: "ollama",
    port: 11434,
    baseUrl: "http://127.0.0.1:11434/v1",
    models: ["qwen2.5-coder:14b"],
  };
  assert.equal(assignProviderId(localOllama, used), "ollama");
  used.add("ollama");
  const ts: AutofindHit = {
    scope: "tailscale",
    host: "valkyrie",
    kind: "sglang",
    port: 30000,
    baseUrl: "http://valkyrie:30000/v1",
    models: ["deepseek-v4-flash"],
  };
  assert.equal(assignProviderId(ts, used), "tailscale_sglang");
  used.add("tailscale_sglang");
  const extra: AutofindHit = {
    scope: "tailscale",
    host: "dutchman",
    kind: "sglang",
    port: 30000,
    baseUrl: "http://dutchman:30000/v1",
    models: ["other"],
  };
  assert.equal(assignProviderId(extra, used), "sglang-dutchman");
});

test("lanHostsFromArpTable keeps private IPv4 neighbors", () => {
  const text = `IP address       HW type     Flags       HW address            Mask     Device
192.168.1.1      0x1         0x2         aa:bb:cc:dd:ee:ff     *        eth0
10.0.0.5         0x1         0x2         11:22:33:44:55:66     *        eth0
127.0.0.1        0x1         0x2         00:00:00:00:00:00     *        lo
8.8.8.8          0x1         0x2         aa:aa:aa:aa:aa:aa     *        eth0
`;
  assert.deepEqual(lanHostsFromArpTable(text), ["192.168.1.1", "10.0.0.5"]);
});

test("runAutofind probes localhost and tailscale, skips embeds, connects slots", async () => {
  const hits = await runAutofind({
    timeoutMs: 200,
    listTailscaleHosts: async () => ["valkyrie"],
    listLanHosts: async () => [],
    fetchImpl: async (input) => {
      const url = String(input);
      if (url === "http://127.0.0.1:11434/api/tags") {
        return new Response(
          JSON.stringify({ models: [{ name: "qwen2.5-coder:14b" }, { name: "nomic-embed-text" }] }),
          { status: 200 }
        );
      }
      if (url === "http://valkyrie:30000/v1/models") {
        return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }), {
          status: 200,
        });
      }
      return new Response("no", { status: 404 });
    },
  });
  assert.equal(hits.hits.length, 2);
  assert.equal(hits.hits[0].kind, "ollama");
  assert.deepEqual(hits.hits[0].models, ["qwen2.5-coder:14b"]);
  assert.equal(hits.hits[1].kind, "sglang");
  assert.equal(hits.hits[1].host, "valkyrie");

  const applied = applyAutofindResults(emptySettings(), hits);
  assert.deepEqual(applied.report.connected.sort(), ["ollama", "tailscale_sglang"]);
  assert.equal(isProviderReady(applied.settings, "ollama"), true);
  assert.equal(isProviderReady(applied.settings, "tailscale_sglang"), true);
  assert.equal(applied.settings.extra.ollama.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(applied.settings.extra.tailscale_sglang.baseUrl, "http://valkyrie:30000/v1");
  assert.deepEqual(applied.settings.discovered.ollama, ["qwen2.5-coder:14b"]);
});

test("autofind reconnects a removed local slot", () => {
  const removed = removeProvider(emptySettings(), "ollama");
  assert.equal(isProviderReady(removed, "ollama"), false);
  const applied = applyAutofindResults(removed, {
    hits: [
      {
        scope: "loopback",
        host: "127.0.0.1",
        kind: "ollama",
        port: 11434,
        baseUrl: "http://127.0.0.1:11434/v1",
        models: ["qwen2.5-coder:14b"],
      },
    ],
    connected: [],
    notes: [],
  });
  assert.equal(isProviderReady(applied.settings, "ollama"), true);
  assert.equal(applied.settings.enabled.ollama, true);
  assert.equal(applied.settings.extra.ollama.baseUrl, "http://127.0.0.1:11434/v1");
  assert.deepEqual(applied.report.connected, ["ollama"]);
});
