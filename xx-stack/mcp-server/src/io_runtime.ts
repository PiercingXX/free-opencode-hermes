import { link, mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

/**
 * The filesystem entry points `atomicWriteTextFile` uses, injectable so a test
 * can assert the durability sequence itself (write → fsync → close → rename →
 * directory fsync). Nothing but a test should pass this — production callers
 * take the default.
 */
export interface AtomicWriteIo {
  open: (path: string, flags: string) => Promise<FileHandle>;
  rename: (from: string, to: string) => Promise<void>;
}

const DEFAULT_ATOMIC_WRITE_IO: AtomicWriteIo = { open, rename };

/**
 * `fsync` on a directory is a POSIX courtesy, not a universal one. Windows has
 * no notion of it, some FUSE and network filesystems reject it, and a few
 * refuse to open a directory for reading at all. None of those is a write
 * failure — the rename already succeeded and the file's own data is already
 * synced — so these codes degrade to "less durable than we asked for" instead
 * of failing the caller's store write. Anything outside this set is a real
 * error and still propagates.
 */
const DIRECTORY_FSYNC_TOLERATED_CODES = new Set([
  "EPERM",
  "EINVAL",
  "EISDIR",
  "EACCES",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EBADF",
]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Best-effort directory fsync. Persists the *directory entry* created by the
 * rename; without it the file contents can survive a crash while the name that
 * reaches them does not.
 */
async function fsyncDirectoryBestEffort(directory: string, io: AtomicWriteIo): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await io.open(directory, "r");
  } catch (error) {
    if (DIRECTORY_FSYNC_TOLERATED_CODES.has(errorCode(error) ?? "")) return;
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!DIRECTORY_FSYNC_TOLERATED_CODES.has(errorCode(error) ?? "")) throw error;
  } finally {
    await handle.close();
  }
}

/**
 * Write `content` to `path` atomically and durably.
 *
 * Atomic rename gives a reader **visibility** — it never observes a half-written
 * document. It does not give **durability**. ext4's auto-fsync-on-rename
 * heuristic usually flushes the replaced file's data, but that is a filesystem
 * courtesy rather than a guarantee (it is off under `data=writeback`, and other
 * filesystems make no such promise), and it never covers the directory entry.
 * This function is the sole writer for the supervisor store, the task store and
 * the memory snapshot metadata, and MANUAL §11 rates store truncation CRITICAL
 * (MCP-1) — the same asset, a different trigger.
 *
 * **The honest trade:** the two fsyncs below add real latency to every store
 * write — an actual disk flush, not a page-cache copy, on paths that run on
 * every task mutation and every supervisor tick. Measured on the real store
 * location (`~/.config`, ext4 on NVMe, 100 writes of a 17.7 KiB document):
 * **0.168 ms/write → 4.088 ms/write**, roughly 24x. On tmpfs it is free
 * (0.118 → 0.116 ms), because there fsync has nothing to flush — so a run
 * benchmarked in /tmp will not show this cost at all.
 *
 * What that buys is narrow: it only matters when the machine loses power or
 * panics in the window between the rename and the kernel's own writeback. That
 * is a rare event with an expensive consequence (a truncated or vanished
 * store), and the ~4 ms is paid on every write whether or not the event ever
 * happens. This is a deliberate choice to make the common case slower so the
 * rare case is not silent data loss — not a free improvement.
 */
/**
 * Best-effort removal of a temp file a failed write left behind. The write may
 * have failed before creating anything (an injected `io` never touches disk) or
 * the file may already be gone, so any unlink failure is ignored — the point is
 * only that a `.tmp-*` orphan does not accumulate next to the real store.
 */
async function removeTempFileBestEffort(tempPath: string): Promise<void> {
  try {
    await unlink(tempPath);
  } catch {
    // Nothing to clean up, or someone else removed it — either is fine.
  }
}

export async function atomicWriteTextFile(
  path: string,
  content: string,
  io: AtomicWriteIo = DEFAULT_ATOMIC_WRITE_IO
): Promise<void> {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const handle = await io.open(tempPath, "w");
  try {
    try {
      await handle.writeFile(content, "utf-8");
      // Flush the temp file's data before it is given the real name: a rename
      // that publishes a name pointing at unflushed blocks is exactly the
      // truncation this is meant to prevent.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await io.rename(tempPath, path);
  } catch (error) {
    await removeTempFileBestEffort(tempPath);
    throw error;
  }
  await fsyncDirectoryBestEffort(dirname(path), io);
}

// --- Store locking -----------------------------------------------------------
//
// The task and supervisor stores are whole-document JSON files under
// ~/.config/opencode shared by every process on the machine: each MCP server a
// host spawns, plus the CLI. Every mutation is read -> mutate -> write, so an
// in-process mutex alone only serializes one process; two processes interleave
// and the last writer silently drops the other's update (a lost lease grant is
// a double lease). `createStoreLock` layers a cross-process lockfile under the
// in-process mutex. Callers already re-read the store inside the lock, which is
// what makes the pair correct: the read happens after the lock is held.

/** A non-reentrant promise-chain mutex: `work` runs only after every earlier call settled. */
export function createProcessMutex(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release: () => void = () => {};
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };
}

export interface FileLockOptions {
  /** Give up acquiring after this long. */
  timeoutMs?: number;
  /** A lock older than this is presumed abandoned and broken, even if its pid looks alive. */
  staleMs?: number;
  /** First retry delay; doubles per attempt up to `maxBackoffMs`, with jitter. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export const DEFAULT_FILE_LOCK_OPTIONS: Required<FileLockOptions> = {
  timeoutMs: 15_000,
  staleMs: 60_000,
  initialBackoffMs: 5,
  maxBackoffMs: 200,
};

interface LockRecord {
  pid: number;
  host: string;
  acquiredAt: number;
  token: string;
}

export class FileLockTimeoutError extends Error {
  readonly lockPath: string;
  constructor(lockPath: string, timeoutMs: number, holder: string) {
    super(
      `file_lock_timeout: could not acquire ${lockPath} within ${timeoutMs}ms (held by ${holder})`
    );
    this.name = "FileLockTimeoutError";
    this.lockPath = lockPath;
  }
}

function parseLockRecord(raw: string): LockRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockRecord>;
    if (typeof parsed.pid !== "number" || typeof parsed.acquiredAt !== "number") return null;
    return {
      pid: parsed.pid,
      host: typeof parsed.host === "string" ? parsed.host : "",
      acquiredAt: parsed.acquiredAt,
      token: typeof parsed.token === "string" ? parsed.token : "",
    };
  } catch {
    return null;
  }
}

function pidIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM means the pid exists but belongs to someone else: alive.
    return errorCode(error) === "ESRCH";
  }
}

/**
 * Is the lock at `raw` abandoned? A lock whose holder is a dead pid on this
 * host is stale immediately (the common crash case); otherwise only age
 * decides. An unparseable record (a holder killed between create and write)
 * is judged by the file's age via `fallbackAgeMs`.
 */
function isStaleLock(
  record: LockRecord | null,
  now: number,
  staleMs: number,
  fallbackAgeMs: number
): boolean {
  if (record === null) return fallbackAgeMs > staleMs;
  if (record.host === hostname() && record.pid !== process.pid && pidIsDead(record.pid))
    return true;
  return now - record.acquiredAt > staleMs;
}

async function tryCreateLock(lockPath: string, record: LockRecord): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(record), "utf-8");
  } finally {
    await handle.close();
  }
  return true;
}

/**
 * Break an abandoned lock without stealing a fresh one. A plain unlink races:
 * two waiters both judge the old lock stale, the first unlinks and acquires,
 * the second then unlinks the FIRST waiter's live lock. Renaming the file away
 * and re-checking what was moved closes that: if the moved file is not the
 * record we judged stale, it is put back with link() (atomic, fails if a newer
 * lock already exists) and nothing is broken.
 */
async function breakStaleLock(lockPath: string, staleRaw: string): Promise<void> {
  const aside = `${lockPath}.stale-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await rename(lockPath, aside);
  } catch {
    return; // someone else already moved or released it
  }
  try {
    const moved = await readFile(aside, "utf-8");
    if (moved !== staleRaw) {
      try {
        await link(aside, lockPath);
      } catch {
        // A newer lock already took the name; the moved one is not ours to restore.
      }
    }
  } finally {
    await removeTempFileBestEffort(aside);
  }
}

async function lockFileAgeMs(lockPath: string, now: number): Promise<number> {
  try {
    const handle = await open(lockPath, "r");
    try {
      return now - (await handle.stat()).mtimeMs;
    } finally {
      await handle.close();
    }
  } catch {
    return 0;
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `work` while holding the cross-process lockfile `<targetPath>.lock`.
 * The lockfile is created with O_EXCL and carries pid/host/timestamp so a
 * crashed holder can be detected and broken. Release only removes the file if
 * it still carries this holder's token, so a holder that outlived `staleMs`
 * and was broken never deletes its successor's lock.
 */
export async function withFileLock<T>(
  targetPath: string,
  work: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_FILE_LOCK_OPTIONS, ...options };
  const lockPath = `${targetPath}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const record: LockRecord = {
    pid: process.pid,
    host: hostname(),
    acquiredAt: 0,
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  };
  const deadline = Date.now() + opts.timeoutMs;
  let backoff = opts.initialBackoffMs;
  let holder = "unknown";

  for (;;) {
    record.acquiredAt = Date.now();
    if (await tryCreateLock(lockPath, record)) break;

    let raw: string | null = null;
    try {
      raw = await readFile(lockPath, "utf-8");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (raw !== null) {
      const existing = parseLockRecord(raw);
      holder = existing ? `pid ${existing.pid}@${existing.host}` : "unparseable lock record";
      const now = Date.now();
      if (isStaleLock(existing, now, opts.staleMs, await lockFileAgeMs(lockPath, now))) {
        await breakStaleLock(lockPath, raw);
        continue;
      }
    }

    if (Date.now() >= deadline) {
      throw new FileLockTimeoutError(lockPath, opts.timeoutMs, holder);
    }
    await delay(backoff + Math.floor(Math.random() * backoff));
    backoff = Math.min(opts.maxBackoffMs, backoff * 2);
  }

  try {
    return await work();
  } finally {
    try {
      const current = parseLockRecord(await readFile(lockPath, "utf-8"));
      if (current?.token === record.token) await unlink(lockPath);
    } catch {
      // Already gone (broken as stale by a waiter) — nothing to release.
    }
  }
}

/**
 * The lock both JSON stores use: an in-process mutex (so one process has at
 * most one waiter polling the lockfile) wrapping the cross-process lockfile.
 * `getTargetPath` is evaluated per call because HOME can change under tests.
 * Non-reentrant, exactly like the mutex it replaces.
 */
export function createStoreLock(
  getTargetPath: () => string,
  options: FileLockOptions = {}
): <T>(work: () => Promise<T>) => Promise<T> {
  const mutex = createProcessMutex();
  return <T>(work: () => Promise<T>) => mutex(() => withFileLock(getTargetPath(), work, options));
}
