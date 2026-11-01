// Small helpers shared by the loop/runner CLIs (run-agent-loop, run-opencode-loop,
// opencode-preflight, opencode-stdin-runner).

export function fail(message, exitCode = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

export async function readStdin() {
  process.stdin.setEncoding("utf-8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

/** Filesystem-safe lowercase slug; "loop" when nothing usable remains. */
export function slugify(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "loop"
  );
}
