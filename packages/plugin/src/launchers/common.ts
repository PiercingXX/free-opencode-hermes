import { accessSync, constants, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { ensureProxyRunning } from "../plugin/lifecycle.js";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The local proxy (started if needed), or exit with a start hint. */
export async function requireRunningProxy(): Promise<{ url: string; token: string }> {
  try {
    return await ensureProxyRunning();
  } catch (error) {
    console.error(`Free OpenCode proxy is not reachable: ${errorText(error)}`);
    console.error("Start it with: free-opencode start");
    process.exit(1);
  }
}

/** Run a catalog/config build step; on failure print `<what>: <error>` and exit 1. */
export async function orExit<T>(what: string, build: () => Promise<T>): Promise<T> {
  try {
    return await build();
  } catch (error) {
    console.error(`${what}: ${errorText(error)}`);
    process.exit(1);
  }
}

/** A fresh 0700 temp directory, removed (best effort) when this process exits. */
export function privateTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  process.on("exit", () => {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });
  return directory;
}

export function proxyV1Url(proxyRootUrl: string): string {
  const stripped = proxyRootUrl.replace(/\/+$/, "");
  return stripped.endsWith("/v1") ? stripped : `${stripped}/v1`;
}

export function which(name: string): string | undefined {
  if (name.includes("/") || name.includes("\\")) {
    return existsSync(name) ? name : undefined;
  }
  const pathEnv = process.env.PATH ?? "";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      try {
        accessSync(candidate, constants.F_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}

export function resolveClientBinary(
  binaryName: string,
  displayName: string,
  installHint: string
): string {
  const found = which(binaryName);
  if (!found) {
    console.error(`Could not find ${displayName} command: ${binaryName}`);
    console.error(installHint);
    process.exit(127);
  }
  return found;
}

export function parseSemver(text: string, pattern: RegExp): [number, number, number] | null {
  const match = pattern.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function versionAtLeast(
  have: [number, number, number] | null,
  need: [number, number, number]
): boolean {
  if (!have) return false;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] > need[i]) return true;
    if (have[i] < need[i]) return false;
  }
  return true;
}

export function binaryVersion(
  binaryPath: string,
  pattern: RegExp
): [number, number, number] | null {
  try {
    const result = spawnSync(binaryPath, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status !== 0) return null;
    return parseSemver(`${result.stdout ?? ""}${result.stderr ?? ""}`, pattern);
  } catch {
    return null;
  }
}

export async function runClientProcess(command: string[], env: NodeJS.ProcessEnv): Promise<never> {
  const child = spawn(command[0], command.slice(1), {
    stdio: "inherit",
    env,
    windowsHide: false,
  });
  const forward = (signal: NodeJS.Signals): void => {
    if (child.pid) {
      try {
        process.kill(child.pid, signal);
      } catch {
        // child already gone
      }
    }
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  const code = await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      console.error(error.message);
      resolve(127);
    });
    child.on("exit", (exitCode, signal) => {
      if (signal) resolve(1);
      else resolve(exitCode ?? 1);
    });
  });
  process.exit(code);
}

export function formatVersion(parts: [number, number, number]): string {
  return parts.join(".");
}
