import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Walk up from this module until we find the git/workspace root that contains
 * xx-stack/. Compiled files live in packages/plugin/dist, source in
 * packages/plugin/src — both are two levels below the repo root.
 */
export function repoRoot(): string {
  const fromEnv = process.env.FREE_OPENCODE_REPO?.trim();
  if (fromEnv) return resolve(fromEnv);

  let dir = here;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "xx-stack", "runtime")) && existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(here, "../../..");
}

export function xxStackDir(): string {
  const fromEnv = process.env.XX_STACK_REPO?.trim();
  if (fromEnv) return resolve(fromEnv);
  return join(repoRoot(), "xx-stack");
}

export function mcpServerEntrypoint(): string {
  return join(xxStackDir(), "mcp-server", "dist", "index.js");
}

export function stateDir(home = homedir()): string {
  return join(home, ".free-opencode");
}

export function settingsPath(home = homedir()): string {
  return join(stateDir(home), "config.json");
}

export function pidPath(home = homedir()): string {
  return join(stateDir(home), "proxy.pid");
}

export function logPath(home = homedir()): string {
  return join(stateDir(home), "proxy.log");
}

export const PROVIDER_ID = "free-opencode";
/** Single model OpenCode advertises. Proxy maps it to Admin default + fallbacks. */
export const CATALOG_MODEL_ID = "default";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8082;
export const TOKEN_ENV = "FREE_OPENCODE_API_KEY";
/** Child-only OpenCode launcher token. Never written to opencode.json. */
export const OPENCODE_LAUNCHER_TOKEN_ENV = "FOC_OPENCODE_API_KEY";
/** Prefix for one-shot Hermes key env vars (`FOC_HERMES_<NONCE>`). */
export const HERMES_LAUNCHER_KEY_PREFIX = "FOC_HERMES_";
export const OPENCODE_MIN_VERSION: [number, number, number] = [1, 18, 18];
export const HERMES_MIN_VERSION: [number, number, number] = [0, 20, 4];
