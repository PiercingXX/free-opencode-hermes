import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { emptySettings } from "../config/settings.js";
import { opencodeAuthPath } from "./auth.js";
import { collectChecks, formatChecks, isLoopbackHost, type Check } from "./doctor.js";
import { pidPath, settingsPath, stateDir } from "../paths.js";

function home(settings?: Record<string, unknown>, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "foc-doctor-"));
  if (settings) {
    mkdirSync(stateDir(dir), { recursive: true });
    writeFileSync(settingsPath(dir), JSON.stringify(settings), { mode });
  }
  return dir;
}

const offline = {
  fetchHealth: async () => null,
  portFree: async () => true,
  probe: async (_s: unknown, id: string) => ({
    ok: true,
    providerId: id,
    baseUrl: "http://x",
    models: ["m"],
  }),
};

function find(checks: Check[], name: string): Check {
  const hit = checks.find((c) => c.name === name);
  assert.ok(hit, `missing check ${name}: ${formatChecks(checks)}`);
  return hit;
}

test("doctor fails on old node and unparseable settings", async () => {
  const dir = home();
  mkdirSync(stateDir(dir), { recursive: true });
  writeFileSync(settingsPath(dir), "{ nope", { mode: 0o600 });
  const checks = await collectChecks({ home: dir, nodeVersion: "v18.19.0", ...offline });
  assert.equal(find(checks, "node").status, "fail");
  assert.equal(find(checks, "settings").status, "fail");
});

test("doctor warns on loose settings mode and --fix tightens it", async () => {
  if (process.platform === "win32") return;
  const dir = home({ ...emptySettings() }, 0o644);
  const before = await collectChecks({ home: dir, nodeVersion: "v20.0.0", ...offline });
  assert.equal(find(before, "settings").status, "warn");
  const after = await collectChecks({ home: dir, nodeVersion: "v20.0.0", fix: true, ...offline });
  assert.equal(find(after, "settings").status, "pass");
  assert.equal(statSync(settingsPath(dir)).mode & 0o777, 0o600);
});

test("doctor flags non-loopback listen, disabled auth, foreign port holder", async () => {
  const dir = home({
    ...emptySettings(),
    listen: { host: "0.0.0.0", port: 8099 },
    proxyAuthEnabled: false,
  });
  const checks = await collectChecks({
    home: dir,
    nodeVersion: "v22.1.0",
    ...offline,
    fetchHealth: async () => ({ ok: false }),
  });
  assert.equal(find(checks, "listen host").status, "warn");
  assert.equal(find(checks, "proxy auth").status, "warn");
  assert.equal(find(checks, "proxy port").status, "fail");
});

test("doctor reports our proxy on the port and a broken auth.json", async () => {
  const dir = home({ ...emptySettings() });
  mkdirSync(join(dir, ".local", "share", "opencode"), { recursive: true });
  writeFileSync(opencodeAuthPath(dir), "{ broken");
  const checks = await collectChecks({
    home: dir,
    nodeVersion: "v22.1.0",
    ...offline,
    fetchHealth: async () => ({ ok: true, service: "free-opencode" }),
  });
  assert.equal(find(checks, "proxy port").status, "pass");
  assert.equal(find(checks, "opencode auth.json").status, "fail");
});

test("doctor warns on a stale pidfile and --fix removes it", async () => {
  const dir = home({ ...emptySettings() });
  writeFileSync(
    pidPath(dir),
    JSON.stringify({ pid: 999999, kind: "detached", startedAt: 1, port: 8082 })
  );
  const before = await collectChecks({ home: dir, nodeVersion: "v22.1.0", ...offline });
  assert.equal(find(before, "pidfile").status, "warn");
  const after = await collectChecks({ home: dir, nodeVersion: "v22.1.0", fix: true, ...offline });
  assert.equal(find(after, "pidfile").status, "pass");
});

test("loopback detection", () => {
  for (const host of ["127.0.0.1", "127.1.2.3", "::1", "localhost"])
    assert.ok(isLoopbackHost(host));
  for (const host of ["0.0.0.0", "192.168.1.5", "::"]) assert.ok(!isLoopbackHost(host));
});
