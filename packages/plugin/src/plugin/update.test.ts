import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { cmdUpdate } from "./update.js";

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "foc-update-"));
}

function git(root: string, args: string[]): void {
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
    cwd: root,
    stdio: "ignore",
  });
}

function cleanGitRepo(root: string): void {
  git(root, ["init", "-q", "-b", "main"]);
  writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
  git(root, ["add", "a.txt"]);
  git(root, ["commit", "-q", "-m", "initial"]);
}

let prevRepo: string | undefined;
const prevEnv = process.env.FREE_OPENCODE_REPO;

afterEach(() => {
  process.env.FREE_OPENCODE_REPO = prevEnv;
  if (!prevRepo) delete process.env.FREE_OPENCODE_REPO;
});

function pointAt(root: string): void {
  prevRepo = root;
  process.env.FREE_OPENCODE_REPO = root;
}

test("update fails clearly when the repo is not a git checkout", async () => {
  const root = tempRepo();
  pointAt(root);
  // No .git directory — repoRoot() resolves to a plain dir.

  const result = await cmdUpdate();
  assert.equal(result.changed, false);
  assert.equal(result.before, "unknown");
  assert.ok(
    result.errors.some((e) => e.includes("not a git checkout")),
    `expected a clear not-a-git-checkout message, got: ${result.errors.join(" | ")}`
  );
  assert.equal(result.steps.length, 0, "no build/install step runs for a non-checkout");
});

test("update fails clearly on a dirty tree and never pulls or rebuilds", async () => {
  const root = tempRepo();
  cleanGitRepo(root);
  pointAt(root);
  assert.equal(isStatusClean(root), "clean");
  writeFileSync(join(root, "a.txt"), "dirty\n", "utf8"); // uncommitted change

  const result = await cmdUpdate();
  assert.equal(result.changed, false);
  assert.ok(
    result.errors.some((e) => e.includes("uncommitted changes")),
    `expected a clear dirty-tree message, got: ${result.errors.join(" | ")}`
  );
  assert.ok(
    !result.steps.some((s) => s.startsWith("git pull")),
    "a dirty tree must halt before any git pull / npm step"
  );
});

// Minimal helper that reports whether the tree is clean via porcelain.
function isStatusClean(root: string): string {
  const out = execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  } as never)
    .toString()
    .trim();
  return out ? "dirty" : "clean";
}
