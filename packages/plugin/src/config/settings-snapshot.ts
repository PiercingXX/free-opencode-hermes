import { readFileSync, statSync } from "node:fs";

import { settingsPath } from "../paths.js";
import { normalizeSettings, type Settings } from "./settings.js";

/**
 * Read-only view of the on-disk settings, cached by file mtime.
 *
 * The provider catalog is rebuilt many times per routed request and needs the
 * registered accounts and found hosts from settings. It used to re-read and
 * re-parse the whole file for every catalog entry on every call. This never
 * creates or rewrites the file (unlike loadSettings).
 */
let cache: { path: string; mtimeMs: number; settings: Settings | null } | null = null;

export function settingsSnapshot(): Settings | null {
  const path = settingsPath();
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  if (cache?.path === path && cache.mtimeMs === mtimeMs) return cache.settings;
  let settings: Settings | null;
  try {
    settings = normalizeSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    settings = null;
  }
  cache = { path, mtimeMs, settings };
  return settings;
}
