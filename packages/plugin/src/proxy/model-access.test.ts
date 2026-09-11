import assert from "node:assert/strict";
import test from "node:test";

import { emptySettings, setProviderKey } from "../config/settings.js";
import {
  accessProbeCandidates,
  classifyAccessStatus,
  parseModelAccessMap,
  probeProviderAccess,
  providerNeedsAccessProbe,
  rememberAccess,
  rememberedAccess,
} from "./model-access.js";
import { isBaiAutoRoutedModel, isFreeOrLearnedOpen } from "./models.js";

test("classifyAccessStatus marks deposit/balance as paywall and 429/200 as open", () => {
  assert.equal(
    classifyAccessStatus(403, "Access restricted. Deposit required to unlock premium models."),
    "paywall"
  );
  assert.equal(
    classifyAccessStatus(400, "credit insufficient balance: balance=0 required=23320"),
    "paywall"
  );
  assert.equal(classifyAccessStatus(429, "rate limited"), "open");
  assert.equal(classifyAccessStatus(200, ""), "open");
  assert.equal(classifyAccessStatus(400, "max_tokens must be greater than 2"), "open");
  assert.equal(classifyAccessStatus(401, "bad key"), null);
});

test("rememberAccess persists open and paywall by slug", () => {
  let settings = emptySettings();
  settings = rememberAccess(settings, "bai/gpt-5-nano", "paywall", "deposit");
  settings = rememberAccess(settings, "bai/qwen3.8-flash", "open");
  assert.equal(rememberedAccess(settings, "bai/gpt-5-nano"), "paywall");
  assert.equal(rememberedAccess(settings, "bai/qwen3.8-flash"), "open");
  assert.equal(rememberedAccess(settings, "bai/hy3"), "unknown");
  const roundTrip = parseModelAccessMap(settings.modelAccess);
  assert.equal(roundTrip["bai/gpt-5-nano"]?.status, "paywall");
});

test("B.ai auto-route requires probed-open, not a static leaf", () => {
  let settings = emptySettings();
  assert.equal(isFreeOrLearnedOpen(settings, "bai", "glm-5.3-flash"), false);
  assert.equal(isBaiAutoRoutedModel("glm-5.3-flash", settings), false);
  settings = rememberAccess(settings, "bai/glm-5.3-flash", "open");
  settings = rememberAccess(settings, "bai/qwen3.8-flash", "open");
  assert.equal(isBaiAutoRoutedModel("glm-5.3-flash", settings), true);
  assert.equal(isBaiAutoRoutedModel("qwen3.8-flash", settings), true);
  assert.equal(isBaiAutoRoutedModel("deepseek-v4.1-flash", settings), false);
});

test("accessProbeCandidates skips deepseek and known paywalls", () => {
  let settings = setProviderKey(emptySettings(), "bai", "k");
  settings.discovered.bai = [
    "glm-5.3-flash",
    "qwen3.8-flash",
    "hy3",
    "mimo-v2.5",
    "deepseek-v4.1-flash",
    "gpt-5-nano",
  ];
  settings = rememberAccess(settings, "bai/gpt-5-nano", "paywall");
  const candidates = accessProbeCandidates(settings, "bai");
  assert.deepEqual(candidates, ["glm-5.3-flash", "qwen3.8-flash", "hy3", "mimo-v2.5"]);
  assert.equal(candidates.includes("deepseek-v4.1-flash"), false);
  assert.equal(candidates.includes("gpt-5-nano"), false);
});

test("probeProviderAccess marks open vs paywall from fake transport", async () => {
  let settings = setProviderKey(emptySettings(), "bai", "k");
  settings.discovered.bai = ["glm-5.3-flash", "qwen3.8-flash", "deepseek-v4.1-flash"];
  assert.equal(providerNeedsAccessProbe(settings, "bai"), true);

  const result = await probeProviderAccess(settings, "bai", {
    force: true,
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      if (body.model === "qwen3.8-flash") {
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
        });
      }
      if (body.model === "glm-5.3-flash") {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
      }
      return new Response(
        JSON.stringify({ error: { message: "credit insufficient balance: balance=0 required=4" } }),
        { status: 400 }
      );
    },
  });

  assert.equal(rememberedAccess(result.settings, "bai/qwen3.8-flash"), "open");
  assert.equal(rememberedAccess(result.settings, "bai/glm-5.3-flash"), "open");
  assert.equal(providerNeedsAccessProbe(result.settings, "bai"), false);
});
