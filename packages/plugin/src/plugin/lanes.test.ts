import assert from "node:assert/strict";
import test from "node:test";

import { emptySettings, setProviderKey } from "../config/settings.js";
import {
  isLaneAgentName,
  laneAgentName,
  laneStrength,
  listReadyLocalLanes,
  pickOrchestratorLane,
} from "./lanes.js";

test("lane agent names are stable and detectable", () => {
  assert.equal(laneAgentName("tailscale_sglang"), "lane-tailscale_sglang");
  assert.equal(isLaneAgentName("lane-llamacpp-dutchman"), true);
  assert.equal(isLaneAgentName("build"), false);
});

test("SGLang / deepseek ranks stronger than llama.cpp brain boxes", () => {
  const sglang = laneStrength("tailscale_sglang", "deepseek-v4-flash");
  const skippy = laneStrength("llamacpp-dutchman", "skippy-brain");
  const nagatha = laneStrength("llamacpp-valkyrie", "nagatha-brain");
  assert.ok(sglang > skippy);
  assert.ok(sglang > nagatha);
});

test("listReadyLocalLanes returns one lane per ready local provider", () => {
  let settings = emptySettings();
  settings = setProviderKey(settings, "tailscale_sglang", "sglang", {
    baseUrl: "http://valkyrie:30000/v1",
  });
  settings.discovered.tailscale_sglang = ["deepseek-v4-flash"];
  settings = setProviderKey(settings, "ollama", "ollama", {
    baseUrl: "http://127.0.0.1:11434/v1",
  });
  settings.discovered.ollama = ["qwen2.5-coder:14b"];
  settings = setProviderKey(settings, "llamacpp", "llamacpp", {
    baseUrl: "http://127.0.0.1:8080/v1",
  });
  settings.discovered.llamacpp = ["skippy-brain"];

  const lanes = listReadyLocalLanes(settings);
  assert.equal(lanes.length, 3);
  assert.deepEqual(
    lanes.map((l) => l.agentName).sort(),
    ["lane-llamacpp", "lane-ollama", "lane-tailscale_sglang"]
  );
  assert.ok(lanes.every((l) => l.wireModel.startsWith("free-opencode/")));

  const orch = pickOrchestratorLane(lanes);
  assert.ok(orch);
  assert.notEqual(orch.providerId, "tailscale_sglang");
});
