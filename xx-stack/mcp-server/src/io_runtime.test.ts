import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";

import {
  atomicWriteTextFile,
  createStoreLock,
  FileLockTimeoutError,
  withFileLock,
  type AtomicWriteIo,
} from "./io_runtime.js";

/**
 * D5: `atomicWriteTextFile` renamed a temp file into place with no fsync
 * anywhere. Atomic rename buys visibility, not durability — the directory
 * entry in particular is never covered by ext4's rename heuristic. These tests
 * assert the durability sequence directly, because the effect of an fsync is
 * not observable through the filesystem API afterwards: the only honest
 * evidence is that the call was made, in the right order, on the right handle.
 */

interface FakeHandle {
  label: string;
  writeFile: (content: string, encoding: string) => Promise<void>;
  sync: () => Promise<void>;
  close: () => Promise<void>;
}

interface Recorder {
  io: AtomicWriteIo;
  calls: string[];
}

interface RecorderOptions {
  /** Thrown from `open` when the path is the parent directory. */
  directoryOpenError?: NodeJS.ErrnoException;
  /** Thrown from `sync()` on the directory handle. */
  directorySyncError?: NodeJS.ErrnoException;
}

function makeRecorder(options: RecorderOptions = {}): Recorder {
  const calls: string[] = [];
  const handleFor = (label: string, syncError?: Error): FileHandle => {
    const handle: FakeHandle = {
      label,
      writeFile: async () => {
        calls.push(`write:${label}`);
      },
      sync: async () => {
        calls.push(`sync:${label}`);
        if (syncError) throw syncError;
      },
      close: async () => {
        calls.push(`close:${label}`);
      },
    };
    return handle as unknown as FileHandle;
  };

  const io: AtomicWriteIo = {
    open: async (path, flags) => {
      if (flags === "r") {
        calls.push("open:dir");
        if (options.directoryOpenError) throw options.directoryOpenError;
        return handleFor("dir", options.directorySyncError);
      }
      assert.ok(path.includes(".tmp-"), `temp writes go to a temp path, got ${path}`);
      calls.push("open:temp");
      return handleFor("temp");
    },
    rename: async () => {
      calls.push("rename");
    },
  };

  return { io, calls };
}

function errnoError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`simulated ${code}`);
  error.code = code;
  return error;
}

test("atomicWriteTextFile fsyncs the file before the rename and the directory after it", async () => {
  const recorder = makeRecorder();

  await atomicWriteTextFile("/store/dir/state.json", '{"ok":true}\n', recorder.io);

  assert.deepEqual(recorder.calls, [
    "open:temp",
    "write:temp",
    // The data flush must precede the rename: publishing a name that points at
    // unflushed blocks is the truncation this exists to prevent.
    "sync:temp",
    "close:temp",
    "rename",
    // The directory entry created by the rename is a separate durability
    // problem and no filesystem heuristic covers it.
    "open:dir",
    "sync:dir",
    "close:dir",
  ]);
});

test("a platform that refuses to open a directory degrades instead of failing the write", async () => {
  for (const code of ["EPERM", "EINVAL", "EISDIR", "EACCES", "ENOSYS", "ENOTSUP"]) {
    const recorder = makeRecorder({ directoryOpenError: errnoError(code) });
    await atomicWriteTextFile("/store/dir/state.json", "payload\n", recorder.io);
    assert.ok(
      recorder.calls.includes("rename"),
      `${code} must not undo the write that already succeeded`
    );
    assert.ok(!recorder.calls.includes("sync:dir"), `${code} means the directory sync never ran`);
  }
});

test("a platform that refuses to fsync a directory degrades and still closes the handle", async () => {
  for (const code of ["EPERM", "EINVAL", "EOPNOTSUPP"]) {
    const recorder = makeRecorder({ directorySyncError: errnoError(code) });
    await atomicWriteTextFile("/store/dir/state.json", "payload\n", recorder.io);
    assert.deepEqual(recorder.calls.slice(-3), ["open:dir", "sync:dir", "close:dir"]);
  }
});

test("an unexpected directory error is not swallowed", async () => {
  const recorder = makeRecorder({ directoryOpenError: errnoError("ENOSPC") });
  await assert.rejects(
    () => atomicWriteTextFile("/store/dir/state.json", "payload\n", recorder.io),
    /simulated ENOSPC/,
    "best-effort covers platforms that cannot fsync a directory, not genuine I/O failures"
  );
});

test("a failed file fsync fails the write rather than publishing unflushed data", async () => {
  const calls: string[] = [];
  const io: AtomicWriteIo = {
    open: async () => {
      calls.push("open");
      return {
        writeFile: async () => {},
        sync: async () => {
          throw errnoError("EIO");
        },
        close: async () => {
          calls.push("close");
        },
      } as unknown as FileHandle;
    },
    rename: async () => {
      calls.push("rename");
    },
  };

  await assert.rejects(() => atomicWriteTextFile("/store/dir/state.json", "payload\n", io), /EIO/);
  assert.ok(!calls.includes("rename"), "an unflushed temp file must never be given the real name");
  assert.ok(calls.includes("close"), "the handle is closed even when the sync fails");
});

// A failed write used to leave its `.tmp-*` behind forever. These tests open a
// REAL temp file through the real fs and then fail a later step, so the
// cleanup can be observed by listing the directory afterwards.

/** Real-fs `open` whose temp handle fails the write step. */
function ioFailingAtWrite(): AtomicWriteIo {
  return {
    open: async (path, flags) => {
      if (flags === "r") return open(path, flags);
      const handle = await open(path, flags);
      return {
        writeFile: async () => {
          throw errnoError("EIO");
        },
        sync: handle.sync.bind(handle),
        close: handle.close.bind(handle),
      } as unknown as FileHandle;
    },
    rename,
  };
}

function ioFailingAtRename(): AtomicWriteIo {
  return {
    open,
    rename: async () => {
      throw errnoError("EACCES");
    },
  };
}

async function assertNoOrphans(dir: string): Promise<void> {
  assert.deepEqual(await readdir(dir), [], "no temp file may survive a failed write");
}

test("a failed write cleans up its temp file instead of orphaning it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-io-tmp-write-"));
  try {
    await assert.rejects(
      () => atomicWriteTextFile(join(dir, "state.json"), "payload\n", ioFailingAtWrite()),
      /EIO/
    );
    await assertNoOrphans(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed rename cleans up its temp file too", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-io-tmp-rename-"));
  try {
    // The temp file genuinely exists here: it was written and synced before the
    // rename was refused.
    await assert.rejects(
      () => atomicWriteTextFile(join(dir, "state.json"), '{"v":1}\n', ioFailingAtRename()),
      /EACCES/
    );
    await assertNoOrphans(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the real filesystem path still writes the content and leaves no temp file behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-io-runtime-"));
  try {
    const path = join(dir, "state.json");
    await atomicWriteTextFile(path, '{"version":1}\n');
    await atomicWriteTextFile(path, '{"version":2}\n');

    assert.equal(await readFile(path, "utf-8"), '{"version":2}\n');
    assert.deepEqual(await readdir(dir), ["state.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Cross-process store lock ---------------------------------------------

/** A read -> yield -> write increment: loses updates unless the lock serializes it. */
async function lockedIncrement(storePath: string): Promise<void> {
  await withFileLock(storePath, async () => {
    let count: number;
    try {
      count = Number(JSON.parse(await readFile(storePath, "utf-8")).count);
    } catch {
      count = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
    await atomicWriteTextFile(storePath, JSON.stringify({ count: count + 1 }));
  });
}

test("two processes incrementing one store under withFileLock lose no updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-file-lock-"));
  try {
    const storePath = join(dir, "store.json");
    const childPath = join(dir, "child.mjs");
    const ioUrl = new URL("./io_runtime.js", import.meta.url).href;
    await writeFile(
      childPath,
      `import { readFile } from "node:fs/promises";
import { atomicWriteTextFile, withFileLock } from ${JSON.stringify(ioUrl)};
const [storePath, iterations] = process.argv.slice(2);
for (let i = 0; i < Number(iterations); i += 1) {
  await withFileLock(storePath, async () => {
    let count;
    try { count = Number(JSON.parse(await readFile(storePath, "utf-8")).count); } catch { count = 0; }
    await new Promise((r) => setTimeout(r, 1));
    await atomicWriteTextFile(storePath, JSON.stringify({ count: count + 1 }));
  });
}
`
    );
    const iterations = 25;
    const runChild = () =>
      new Promise<number | null>((resolve, reject) => {
        const child = fork(childPath, [storePath, String(iterations)], { stdio: "inherit" });
        child.on("error", reject);
        child.on("exit", (code) => resolve(code));
      });
    // Two child processes plus this process all contend for the same lock.
    const parentWork = (async () => {
      for (let i = 0; i < iterations; i += 1) await lockedIncrement(storePath);
    })();
    const codes = await Promise.all([runChild(), runChild(), parentWork]);
    assert.deepEqual(codes.slice(0, 2), [0, 0]);
    const final = JSON.parse(await readFile(storePath, "utf-8")) as { count: number };
    assert.equal(final.count, iterations * 3, "every increment must survive");
    const leftovers = (await readdir(dir)).filter((name) => name.includes(".lock"));
    assert.deepEqual(leftovers, [], "the lockfile is released after the last holder");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lock left by a dead pid on this host is broken immediately", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-file-lock-"));
  try {
    const storePath = join(dir, "store.json");
    // A pid that cannot be running: far above any real pid_max.
    await writeFile(
      `${storePath}.lock`,
      JSON.stringify({ pid: 2 ** 30, host: hostname(), acquiredAt: Date.now(), token: "dead" })
    );
    const ran = await withFileLock(storePath, async () => "ran", { timeoutMs: 1_000 });
    assert.equal(ran, "ran");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lock older than staleMs is broken even when its holder looks alive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-file-lock-"));
  try {
    const storePath = join(dir, "store.json");
    await writeFile(
      `${storePath}.lock`,
      JSON.stringify({ pid: process.ppid, host: "other-host", acquiredAt: 0, token: "old" })
    );
    const ran = await withFileLock(storePath, async () => "ran", { timeoutMs: 1_000 });
    assert.equal(ran, "ran");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a live, fresh lock is waited on and then times out with a named holder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-file-lock-"));
  try {
    const storePath = join(dir, "store.json");
    await writeFile(
      `${storePath}.lock`,
      JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: Date.now(), token: "live" })
    );
    await assert.rejects(
      withFileLock(storePath, async () => "ran", { timeoutMs: 150 }),
      (error: unknown) =>
        error instanceof FileLockTimeoutError && error.message.includes(`pid ${process.pid}`)
    );
    // The waiter must not have deleted the live holder's lock.
    const still = JSON.parse(await readFile(`${storePath}.lock`, "utf-8")) as { token: string };
    assert.equal(still.token, "live");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createStoreLock serializes in-process callers and releases on a throwing body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xx-stack-file-lock-"));
  try {
    const storePath = join(dir, "store.json");
    const lock = createStoreLock(() => storePath);
    const order: string[] = [];
    await assert.rejects(
      lock(async () => {
        throw new Error("boom");
      })
    );
    await Promise.all([
      lock(async () => {
        order.push("a-start");
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("a-end");
      }),
      lock(async () => {
        order.push("b");
      }),
    ]);
    assert.deepEqual(order, ["a-start", "a-end", "b"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
