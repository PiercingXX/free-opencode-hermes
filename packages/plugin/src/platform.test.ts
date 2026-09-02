import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fileUrlFromPath, isWindows, opencodeConfigDir, userBinDir } from "./platform.js";

test("fileUrlFromPath is a file:// URL OpenCode can import", () => {
  if (isWindows()) {
    const url = fileUrlFromPath("C:\\Users\\demo\\free-opencode\\packages\\plugin\\src\\index.ts");
    assert.equal(url.startsWith("file:///"), true);
    assert.match(url, /^file:\/\/\/C:\//);
    assert.equal(url.includes("\\"), false);
  } else {
    assert.equal(fileUrlFromPath("/home/demo/src/index.ts"), "file:///home/demo/src/index.ts");
  }
});

test("opencode config dir is ~/.config/opencode on every OS", () => {
  const previous = process.env.XDG_CONFIG_HOME;
  try {
    delete process.env.XDG_CONFIG_HOME;
    assert.equal(opencodeConfigDir("/tmp/home"), join("/tmp/home", ".config", "opencode"));
    process.env.XDG_CONFIG_HOME = join("/tmp", "xdg");
    assert.equal(opencodeConfigDir(), join("/tmp", "xdg", "opencode"));
    assert.equal(opencodeConfigDir("/tmp/home"), join("/tmp/home", ".config", "opencode"));
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

test("user bin dir is ~/.local/bin on every OS", () => {
  assert.equal(userBinDir(homedir()).endsWith(join(".local", "bin")), true);
});
