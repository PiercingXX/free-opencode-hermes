import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntimeAgents } from "./plugin/agents.js";
import {
  OPENCODE_AGENT_STEPS_FLOOR,
  applyRuntimeExtras,
  catalogAgentOverlay,
  catalogModelRef,
  fccStyleAgentOverlay,
  neutralizeVendorAgents,
  openCodeAgentSteps,
  pinAgentsToCatalog,
  stripNativePrimaryAgentFiles,
  type MutableConfig,
} from "./plugin/config.js";

test("loadRuntimeAgents reads frontmatter and registry metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "foc-agents-"));
  mkdirSync(join(root, "runtime", "agents"), { recursive: true });
  writeFileSync(
    join(root, "runtime", "config.json"),
    JSON.stringify({
      agent: {
        build: {
          description: "Primary execution agent.",
          mode: "primary",
          temperature: 0.2,
          steps: 18,
          permission: { edit: "allow", bash: "allow" },
        },
      },
    })
  );
  writeFileSync(
    join(root, "runtime", "agents", "build.md"),
    `---
name: build
mode: primary
---

# Build Agent

You implement.
`
  );
  writeFileSync(join(root, "runtime", "agents", "ping.md"), "---\nname: ping\n---\nskip me\n");

  const agents = loadRuntimeAgents(root);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, "build");
  assert.equal(agents[0].mode, "primary");
  assert.equal(agents[0].permission?.edit, "allow");
  assert.equal(agents[0].steps, 18);
  assert.match(agents[0].prompt, /You implement/);
});

test("OpenCode agent steps floor overrides xx-stack markdown budgets", () => {
  assert.equal(openCodeAgentSteps(12), OPENCODE_AGENT_STEPS_FLOOR);
  assert.equal(openCodeAgentSteps(undefined), OPENCODE_AGENT_STEPS_FLOOR);
  assert.ok(openCodeAgentSteps(200) >= OPENCODE_AGENT_STEPS_FLOOR);
  const config: MutableConfig = {
    agent: {
      reviewer: { steps: 12, prompt: "stale", mode: "subagent" },
      ping: { steps: 2, mode: "primary" },
      planning: { steps: 12, mode: "subagent" },
    },
  };
  applyRuntimeExtras(config);
  const reviewer = config.agent?.reviewer as { steps: number; prompt: string };
  assert.equal(reviewer.steps, OPENCODE_AGENT_STEPS_FLOOR);
  assert.notEqual(reviewer.prompt, "stale");
  const ping = config.agent?.ping as { disable?: boolean; hidden?: boolean; mode?: string };
  assert.equal(ping.disable, true);
  assert.equal(ping.hidden, true);
  assert.equal(ping.mode, "subagent");
  const planning = config.agent?.planning as { disable?: boolean };
  assert.equal(planning.disable, true);
  assert.equal(config.tools?.foc_status, true);
  assert.equal(config.tools?.foc_models, true);
  const reviewerTools = (config.agent?.reviewer as { tools?: Record<string, boolean> }).tools;
  assert.equal(reviewerTools?.foc_status, true);
  assert.equal(reviewerTools?.foc_models, true);
});

test("stale xx-stack agent models are rewritten to the catalog alias", () => {
  const config: MutableConfig = {
    agent: {
      build: { model: "ollama-local/qwen3-coder:30b-a3b-tq2_0", steps: 12 },
      plan: { model: "sglang-remote/qwen3-coder-next" },
    },
  };
  applyRuntimeExtras(config);
  const build = config.agent?.build as { model: string };
  const plan = config.agent?.plan as { model: string };
  assert.equal(build.model, catalogModelRef());
  assert.equal(plan.model, "free-opencode/default");
  pinAgentsToCatalog(config);
  assert.equal((config.agent?.build as { model: string }).model, "free-opencode/default");
  assert.deepEqual(catalogAgentOverlay(["build", "reviewer"]).build, {
    model: "free-opencode/default",
  });
});

test("neutralizeVendorAgents drops native prompts and leaves xx-stack agents visible", () => {
  const config: MutableConfig = {
    agent: {
      build: { prompt: "You implement. You do not plan.", mode: "primary" },
      architect: { prompt: "architecture", mode: "primary" },
    },
  };
  neutralizeVendorAgents(config);
  const build = config.agent?.build as { prompt?: string; mode: string; disable?: boolean };
  const architect = config.agent?.architect as {
    disable?: boolean;
    hidden?: boolean;
    mode?: string;
    prompt?: string;
  };
  assert.equal(build.prompt, undefined);
  assert.equal(build.mode, "primary");
  assert.equal(build.disable, false);
  assert.equal(architect.prompt, "architecture");
  assert.notEqual(architect.disable, true);
  assert.notEqual(architect.hidden, true);
  const overlay = fccStyleAgentOverlay();
  assert.equal("prompt" in (overlay.build ?? {}), false);
  assert.equal(overlay.architect, undefined);
});

test("applyRuntimeExtras loads xx-stack agents and leaves native build without a prompt", () => {
  const config: MutableConfig = {
    agent: { build: { prompt: "native", mode: "primary" } },
  };
  applyRuntimeExtras(config);
  assert.equal((config.agent?.build as { prompt?: string }).prompt, undefined);
  const reviewer = config.agent?.reviewer as { prompt?: string; disable?: boolean };
  assert.ok(reviewer?.prompt && reviewer.prompt.length > 0);
  assert.notEqual(reviewer.disable, true);
});

test("stripNativePrimaryAgentFiles unlinks leftover build/plan/general markdown", () => {
  const home = mkdtempSync(join(tmpdir(), "foc-home-"));
  const agents = join(home, ".config", "opencode", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "build.md"), "# leftover build\n");
  writeFileSync(join(agents, "plan.md"), "# leftover plan\n");
  writeFileSync(join(agents, "reviewer.md"), "# keep\n");
  const removed = stripNativePrimaryAgentFiles(home);
  assert.deepEqual([...removed].sort(), ["build.md", "plan.md"]);
  assert.equal(existsSync(join(agents, "build.md")), false);
  assert.equal(existsSync(join(agents, "plan.md")), false);
  assert.equal(existsSync(join(agents, "reviewer.md")), true);
  assert.deepEqual(stripNativePrimaryAgentFiles(home), []);
});
