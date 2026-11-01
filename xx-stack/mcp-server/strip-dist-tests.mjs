#!/usr/bin/env node
/**
 * Post-tsc build step: drop tsc test artifacts from dist/ and ship the
 * catastrophic-command denylist into dist/ beside execution_policy.js (which
 * fails closed when it cannot find one). Unix `rm -f` / `cp` are not Windows
 * commands, and install-opencode.ps1 runs this build.
 */
import { copyFileSync, existsSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

try {
  for (const name of readdirSync(dist)) {
    if (/\.test\.(js|d\.ts)$/.test(name)) unlinkSync(join(dist, name));
  }
} catch (err) {
  if (err && err.code !== "ENOENT") throw err;
}

// Canonical first, then the standalone opencode-orchestration layout.
const patternSource = ["../runtime/dangerous-patterns.txt", "../opencode/dangerous-patterns.txt"]
  .map((candidate) => join(root, candidate))
  .find((candidate) => existsSync(candidate));
if (patternSource && existsSync(dist)) {
  copyFileSync(patternSource, join(dist, "dangerous-patterns.txt"));
}

if (process.argv.includes("--dist-test")) {
  rmSync(join(root, "dist-test"), { recursive: true, force: true });
}
