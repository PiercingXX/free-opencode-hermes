import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write a file atomically: write a sibling temp file, then rename over the
 * target. Readers never observe a half-written file. `mode` is enforced on
 * every write (not just on create), so a pre-existing 0644 file holding
 * secrets is tightened to 0600.
 */
export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, data, { encoding: "utf8", mode });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  try {
    chmodSync(path, mode);
  } catch {
    // Windows / exotic filesystems: best effort.
  }
}
