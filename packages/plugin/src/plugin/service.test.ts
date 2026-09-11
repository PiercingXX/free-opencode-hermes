import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  __serviceRuntime,
  __setExecFileSync,
  __setSpawnSync,
  __setTestHome,
  __setTestPlatform,
  serviceInstall,
  serviceStatus,
  serviceUninstall,
  windowsTaskScriptPath,
  writeWindowsTaskScript,
} from "./service.js";

type ExecCall = { cmd: string; args: string[] };

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "foc-service-"));
}

function setUp(opts: { platform: NodeJS.Platform; spawn?: ExecCall[]; exec?: ExecCall[] }) {
  __setTestPlatform(opts.platform);
  // Stub BOTH child-process entrypoints so the installer never touches a real
  // systemctl / launchctl / schtasks. This is what keeps CI free of real
  // service side-effects regardless of the host OS.
  const spawn = opts.spawn ?? [];
  const exec = opts.exec ?? [];
  __setSpawnSync((cmd, args) => {
    spawn.push({ cmd, args });
    return { status: 0, error: undefined as unknown as Error, stdout: "", stderr: "" };
  });
  __setExecFileSync((cmd, args) => {
    exec.push({ cmd, args });
    return "";
  });
  return { spawn, exec };
}

afterEach(() => {
  __setTestHome(null);
  __setTestPlatform(null);
  __setSpawnSync(null);
  __setExecFileSync(null);
});

test("serviceInstall on linux writes a systemd unit into the temp HOME without running systemd", () => {
  const home = tempHome();
  __setTestHome(home);
  const calls = setUp({ platform: "linux" });

  serviceInstall();

  const unitPath = join(home, ".config", "systemd", "user", "free-opencode-proxy.service");
  assert.ok(existsSync(unitPath), "unit file is written under the temp HOME");
  const unit = readFileSync(unitPath, "utf8");
  assert.ok(unit.includes("Description=Free OpenCode proxy"), "unit carries the description");
  assert.ok(unit.includes("ExecStart="), "unit runs the proxy");
  assert.ok(unit.includes("WantedBy=default.target"));

  // The installer still asked systemctl to reload/enable (recorded, not run),
  // and asked loginctl for linger — all captured by the recorder stubs.
  const systemctl = calls.spawn.filter((c) => c.cmd === "systemctl");
  assert.ok(systemctl.length >= 2, "systemctl daemon-reload + enable are invoked");
  assert.deepEqual(systemctl[0].args, ["--user", "daemon-reload"]);
  assert.ok(
    calls.spawn.some((c) => c.cmd === "loginctl"),
    "linger is best-effort attempted"
  );

  // No real service was touched: asserting install while stubbing is proof the
  // call path is exercised, and the temp HOME file is the only side effect.
  rmSync(home, { recursive: true, force: true });
});

test("serviceInstall on win32 points schtasks /TR at a helper .cmd (no nested node quotes)", () => {
  const home = tempHome();
  __setTestHome(home);
  const calls = setUp({ platform: "win32" });

  serviceInstall();

  const schtasks = calls.spawn.filter((c) => c.cmd === "schtasks");
  assert.equal(schtasks.length, 1, "exactly one schtasks /Create is issued");
  assert.ok(schtasks[0].args.includes("/Create"));
  assert.ok(schtasks[0].args.includes("free-opencode-proxy"));
  const trIdx = schtasks[0].args.indexOf("/TR");
  assert.ok(trIdx >= 0);
  const tr = schtasks[0].args[trIdx + 1];
  assert.equal(tr, windowsTaskScriptPath(home), "/TR is the helper script path only");
  assert.ok(!tr.includes("node"), "nested node.exe path must not appear in /TR");
  assert.ok(existsSync(windowsTaskScriptPath(home)), "helper .cmd is written under the temp HOME");
  const body = readFileSync(windowsTaskScriptPath(home), "utf8");
  assert.ok(body.includes("start --foreground"));
  assert.ok(
    calls.spawn.every((c) => c.cmd === "schtasks"),
    "only schtasks is asked for on Windows (stubbed so real schtasks never runs)"
  );
  rmSync(home, { recursive: true, force: true });
});

test("writeWindowsTaskScript prefers free-opencode.cmd when present", () => {
  const home = tempHome();
  __setTestHome(home);
  __setTestPlatform("win32");
  const wrapperDir = join(home, ".local", "bin");
  mkdirSync(wrapperDir, { recursive: true });
  writeFileSync(join(wrapperDir, "free-opencode.cmd"), "@echo off\r\n");
  const script = writeWindowsTaskScript(home);
  const body = readFileSync(script, "utf8");
  assert.ok(body.includes("free-opencode.cmd"));
  assert.ok(body.includes("start --foreground"));
  rmSync(home, { recursive: true, force: true });
});

test("serviceInstall on win32 fails when schtasks returns non-zero", () => {
  const home = tempHome();
  __setTestHome(home);
  __setTestPlatform("win32");
  __setSpawnSync(() => ({
    status: 1,
    error: undefined as unknown as Error,
    stdout: "",
    stderr: "ERROR: The task XML contains a value which is incorrectly formatted or out of range.\r\n",
  }));
  __setExecFileSync(() => "");

  assert.throws(() => serviceInstall(), /incorrectly formatted|schtasks \/Create failed/);
  rmSync(home, { recursive: true, force: true });
});

test("serviceInstall on mac writes a launchd plist into the temp HOME", () => {
  const home = tempHome();
  __setTestHome(home);
  const calls = setUp({ platform: "darwin" });

  serviceInstall();

  const plistPath = join(home, "Library", "LaunchAgents", "com.free-opencode.proxy.plist");
  assert.ok(existsSync(plistPath), "plist is written under the temp HOME");
  const plist = readFileSync(plistPath, "utf8");
  assert.ok(plist.includes("com.free-opencode.proxy"));
  assert.ok(
    calls.spawn.some((c) => c.cmd === "launchctl"),
    "launchctl bootstrap is invoked"
  );
  rmSync(home, { recursive: true, force: true });
});

test("serviceUninstall on linux removes the unit and asks systemctl disable", () => {
  const home = tempHome();
  __setTestHome(home);
  const calls = setUp({ platform: "linux" });
  // Install first so there is a unit file to remove.
  serviceInstall();
  const unitPath = join(home, ".config", "systemd", "user", "free-opencode-proxy.service");
  assert.ok(existsSync(unitPath));

  serviceUninstall();

  const systemctl = calls.exec.filter((c) => c.cmd === "systemctl");
  assert.ok(
    systemctl.some((c) => c.args.includes("disable")),
    "systemctl disable --now is asked"
  );
  assert.ok(!existsSync(unitPath), "unit file is removed");
  rmSync(home, { recursive: true, force: true });
});

test("serviceStatus reads the on-disk unit, not a live systemd answer", () => {
  const home = tempHome();
  __setTestHome(home);
  setUp({ platform: "linux" });

  const before = serviceStatus();
  assert.equal(before.installed, false);
  assert.equal(before.source, "systemd");

  serviceInstall();
  const after = serviceStatus();
  assert.equal(after.installed, true);
  assert.equal(after.source, "systemd");

  rmSync(home, { recursive: true, force: true });
});
