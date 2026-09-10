#!/usr/bin/env node
/**
 * Regression guard: the two unattended orchestrators must NOT carry an
 * OpenCode `steps` key.
 *
 * OpenCode treats `steps` as a hard tool-call cap. When it's set, the runtime
 * injects CRITICAL-MAXIMUM-STEPS-REACHED at the cap, disables tools, and the
 * model spirals on the same handoff text because spawn/handoff is a tool. The
 * unattended orchestrators must run until the model stops, so they omit `steps`
 * entirely (never 0 or 99999) — in YAML frontmatter and in config.json.
 *
 * Layout: this script lives in xx-stack/scripts/. Standalone xx-stack has
 * runtime/ and opencode-orchestration/ next to scripts/. Free OpenCode keeps
 * xx-stack nested and the OpenCode mirrors at repo-root opencode-orchestration/.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const xxStackRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parent = path.dirname(xxStackRoot);
const focLayout =
  fs.existsSync(path.join(parent, "packages/plugin")) &&
  fs.existsSync(path.join(parent, "opencode-orchestration"));
const mirrorRoot = focLayout
  ? path.join(parent, "opencode-orchestration")
  : path.join(xxStackRoot, "opencode-orchestration");

const ORCHESTRATORS = ["execution-orchestrator", "parallel-execution-orchestrator"];
const failures = [];

function rel(from, abs) {
  return path.relative(focLayout ? parent : xxStackRoot, abs) || abs;
}

function assertJsonConfig(abs, purpose) {
  const text = fs.readFileSync(abs, "utf8");
  const json = JSON.parse(text);
  for (const name of ORCHESTRATORS) {
    const agent = json.agent?.[name];
    if (!agent) {
      failures.push(`${rel(xxStackRoot, abs)} :: ${purpose} is missing agent entry "${name}"`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(agent, "steps")) {
      failures.push(
        `${rel(xxStackRoot, abs)} :: ${purpose} agent "${name}" still declares "steps": ${JSON.stringify(agent.steps)}`
      );
    }
  }
}

function assertAgentFile(abs) {
  const label = rel(xxStackRoot, abs);
  const text = fs.readFileSync(abs, "utf8");
  if (!text.startsWith("---\n")) {
    failures.push(`${label} :: does not start with YAML frontmatter`);
    return;
  }
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) {
    failures.push(`${label} :: could not find the end of YAML frontmatter`);
    return;
  }
  const frontmatter = text.slice(4, end);
  const stepsMatch = /(^|\n)steps\s*:\s*\d+/.exec(frontmatter);
  if (stepsMatch) {
    failures.push(
      `${label} :: orchestrator frontmatter still declares "steps": ${stepsMatch[0].trim()}`
    );
  }
}

assertJsonConfig(path.join(xxStackRoot, "runtime/config.json"), "canonical config");
assertJsonConfig(path.join(mirrorRoot, "opencode/config.json"), "opencode mirror config");

for (const name of ORCHESTRATORS) {
  assertAgentFile(path.join(xxStackRoot, "runtime/agents", `${name}.md`));
  assertAgentFile(path.join(mirrorRoot, "opencode/agents", `${name}.md`));
}

console.log("orchestrator steps regression check");
console.log("");
if (failures.length === 0) {
  console.log(
    "PASS  execution-orchestrator and parallel-execution-orchestrator carry no `steps` key."
  );
} else {
  for (const f of failures) console.log(`FAIL  ${f}`);
  console.log("");
  console.log(`${failures.length} step-cap regression(s) found. An unattended orchestrator with`);
  console.log("a `steps` cap will be shut down mid-loop at the tool-call limit. Delete the key;");
  console.log("do not set it to 0 or 99999.");
}

process.exitCode = failures.length === 0 ? 0 : 1;
