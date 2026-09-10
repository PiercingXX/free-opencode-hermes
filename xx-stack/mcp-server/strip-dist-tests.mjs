#!/usr/bin/env node
/**
 * Drop tsc test artifacts from dist/. Unix `rm -f` is not a Windows command,
 * and install-opencode.ps1 runs this build.
 */
import { readdirSync, rmSync, unlinkSync } from "node:fs";
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

if (process.argv.includes("--dist-test")) {
  rmSync(join(root, "dist-test"), { recursive: true, force: true });
}
