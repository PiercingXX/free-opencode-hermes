/**
 * Point MCP tests at a throwaway home so they never mkdir the developer's
 * ~/.config/opencode (and so a sandbox that cannot write there still passes).
 *
 * Loaded first via `node --import ./test-isolate-home.mjs`.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isolated = mkdtempSync(join(tmpdir(), "xx-mcp-home-"));
process.env.HOME = isolated;
process.env.USERPROFILE = isolated;
const xdg = join(isolated, ".config");
mkdirSync(xdg, { recursive: true });
process.env.XDG_CONFIG_HOME = xdg;
mkdirSync(join(xdg, "opencode"), { recursive: true });
mkdirSync(join(xdg, "xx-stack"), { recursive: true });
