import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { isPidAlive, processCommandLine } from "../platform.js";
import {
  __pidProbe,
  inspectPidfile,
  parsePidRecord,
  readPidRecord,
  stopDetachedProxy,
  writePidRecord,
} from "./lifecycle.js";

function tempPidfile(): string {
  return join(mkdtempSync(join(tmpdir(), "foc-pid-")), "proxy.pid");
}

afterEach(() => {
  __pidProbe.isAlive = isPidAlive;
  __pidProbe.commandLine = processCommandLine;
});

test("pid records round-trip as JSON with owner kind and 0600 mode", () => {
  const path = tempPidfile();
  writePidRecord({ pid: 4242, kind: "detached", port: 8082 }, path);
  const record = readPidRecord(path);
  assert.equal(record?.pid, 4242);
  assert.equal(record?.kind, "detached");
  assert.equal(record?.port, 8082);
  assert.ok((record?.startedAt ?? 0) > 0);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("legacy plain-number pidfiles parse as unverified detached records", () => {
  assert.deepEqual(parsePidRecord("1234\n"), {
    pid: 1234,
    kind: "detached",
    startedAt: 0,
    port: 0,
    legacy: true,
  });
  assert.equal(parsePidRecord("garbage"), null);
  assert.equal(parsePidRecord(JSON.stringify({ pid: 5, kind: "bogus" })), null);
});

test("an in-process (host) proxy pid is never killed", () => {
  const path = tempPidfile();
  // Our own pid stands in for the OpenCode host: it is alive, and killing it
  // would end this test run.
  writePidRecord({ pid: process.pid, kind: "in-process", port: 8082 }, path);
  const result = stopDetachedProxy(path);
  assert.equal(result.stopped, false);
  assert.match(result.reason, /in-process/);
  assert.ok(existsSync(path), "a live host's pidfile is left in place");
});

test("a recorded pid reused by an unrelated process is not killed; pidfile removed", () => {
  const path = tempPidfile();
  writeFileSync(path, "999999\n"); // legacy format
  __pidProbe.isAlive = () => true;
  __pidProbe.commandLine = () => "/usr/bin/vim notes.txt";
  const state = inspectPidfile(path);
  assert.equal(state.state, "stale");
  const result = stopDetachedProxy(path);
  assert.equal(result.stopped, false);
  assert.ok(!existsSync(path));
});

test("a dead pid leaves a stale pidfile that stop removes", () => {
  const path = tempPidfile();
  writePidRecord({ pid: 999999, kind: "detached", port: 8082 }, path);
  __pidProbe.isAlive = () => false;
  assert.equal(inspectPidfile(path).state, "stale");
  stopDetachedProxy(path);
  assert.ok(!existsSync(path));
});

test("a verified detached proxy is killable", () => {
  const path = tempPidfile();
  writePidRecord({ pid: 999999, kind: "detached", port: 8082 }, path);
  __pidProbe.isAlive = () => true;
  __pidProbe.commandLine = () =>
    "/usr/bin/node /repo/packages/plugin/dist/cli.js start --foreground";
  const state = inspectPidfile(path);
  assert.equal(state.state, "live");
  assert.equal(state.state === "live" && state.killable, true);
  // stopDetachedProxy would now signal pid 999999 (nonexistent → harmless).
  const result = stopDetachedProxy(path);
  assert.equal(result.stopped, true);
  assert.ok(!existsSync(path));
});

test("health pid is authoritative: match is killable, mismatch with a foreign process is stale", () => {
  const path = tempPidfile();
  writePidRecord({ pid: 999999, kind: "detached", port: 8082 }, path);
  __pidProbe.isAlive = () => true;
  __pidProbe.commandLine = () => null; // command line unreadable
  const match = inspectPidfile(path, 999999);
  assert.equal(match.state === "live" && match.killable, true);
  __pidProbe.commandLine = () => "/Applications/OpenCode.app/opencode";
  assert.equal(inspectPidfile(path, 1234).state, "stale");
});

test("in-process records are never killable even when health reports the same pid", () => {
  const path = tempPidfile();
  writePidRecord({ pid: process.pid, kind: "in-process", port: 8082 }, path);
  const state = inspectPidfile(path, process.pid);
  assert.equal(state.state === "live" && state.killable, false);
});
