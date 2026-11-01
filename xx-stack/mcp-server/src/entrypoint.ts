import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Is the module at `moduleUrl` (pass `import.meta.url`) the script node was
 * invoked with? Entry modules gate their side effects on this so importing
 * them from a test never starts a server, a live check, or a run.
 *
 * Real paths are compared, not lexical ones. Components reach this server
 * through a symlinked mcp-server/ directory, so the invoked path and
 * import.meta.url legitimately differ; a lexical comparison made the server
 * exit 0 without ever starting, which reads as "crashed silently" to every
 * caller.
 */
export function isDirectExecution(moduleUrl: string): boolean {
  if (!process.argv[1]) return false;
  const realOrSelf = (candidate: string): string => {
    try {
      return realpathSync(candidate);
    } catch {
      return resolve(candidate);
    }
  };
  return realOrSelf(process.argv[1]) === realOrSelf(fileURLToPath(moduleUrl));
}
