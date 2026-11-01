import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PROVIDER_ID } from "../paths.js";
import { ensureFreeOpenCodeAuth, opencodeAuthPath, readOpenCodeAuth } from "./auth.js";

function homeWithAuth(body?: string): { home: string; path: string } {
  const home = mkdtempSync(join(tmpdir(), "foc-auth-"));
  const path = opencodeAuthPath(home);
  if (body !== undefined) {
    mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
    writeFileSync(path, body, { mode: 0o644 });
  }
  return { home, path };
}

test("an unparseable auth.json is never rewritten (other credentials survive)", () => {
  const original = '{ "anthropic": { "type": "api", "key": "sk-keep" }, }';
  const { home, path } = homeWithAuth(original);
  assert.equal(readOpenCodeAuth(home).state, "invalid");
  assert.throws(() => ensureFreeOpenCodeAuth("proxy-token", home), /not valid JSON/);
  assert.equal(readFileSync(path, "utf8"), original);
});

test("auth.json merge preserves other providers and enforces 0600", () => {
  const { home, path } = homeWithAuth(JSON.stringify({ opencode: { type: "api", key: "sk-x" } }));
  ensureFreeOpenCodeAuth("proxy-token", home);
  const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, { key: string }>;
  assert.equal(saved.opencode.key, "sk-x");
  assert.equal(saved[PROVIDER_ID].key, "proxy-token");
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("a missing auth.json is created", () => {
  const { home, path } = homeWithAuth();
  ensureFreeOpenCodeAuth("proxy-token", home);
  const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, { key: string }>;
  assert.equal(saved[PROVIDER_ID].key, "proxy-token");
});
