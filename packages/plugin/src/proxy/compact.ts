/**
 * Conservative tool-output compaction for chat requests.
 *
 * Free tiers have small context windows and tight tokens-per-minute limits,
 * and in coding sessions most of the payload is tool output (test runs,
 * builds, file dumps). Two lossy-but-safe transforms run on `role: "tool"`
 * messages only — user, system and assistant text is never touched:
 *
 *   1. Dedup: a tool result byte-identical to an earlier one in the same
 *      request is replaced by a short pointer to the earlier call.
 *   2. Head + tail: a tool result longer than `maxToolChars` keeps its first
 *      and last parts (errors and summaries live at the ends) around an
 *      explicit "[… N chars omitted …]" marker.
 *
 * Both transforms depend only on a message and the ones before it, so a
 * growing conversation compacts identically on every turn — the prefix stays
 * stable and upstream prompt caches keep hitting.
 *
 * Opt out per request with the `x-foc-compaction: off` header, or globally
 * with FREE_OPENCODE_COMPACTION=off.
 */

export type CompactionMode = "off" | "safe";

export type CompactionOptions = {
  mode: CompactionMode;
  /** Tool results longer than this are trimmed to head + tail. */
  maxToolChars: number;
  /** Results shorter than this are never deduplicated (pointer not worth it). */
  minDedupChars: number;
};

export const DEFAULT_COMPACTION: CompactionOptions = {
  mode: "safe",
  maxToolChars: 32_000,
  minDedupChars: 512,
};

export type CompactionReport = {
  savedChars: number;
  trimmed: number;
  deduped: number;
};

type ChatMessage = Record<string, unknown> & { role?: unknown; content?: unknown };

export function compactionMode(header: string | string[] | undefined): CompactionMode {
  const raw = (Array.isArray(header) ? header[0] : header)?.trim().toLowerCase();
  if (raw === "off" || raw === "none" || raw === "0") return "off";
  if (raw === "safe" || raw === "on") return "safe";
  const env = process.env.FREE_OPENCODE_COMPACTION?.trim().toLowerCase();
  return env === "off" || env === "0" ? "off" : DEFAULT_COMPACTION.mode;
}

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  // Chat content parts: only all-text arrays are safe to rewrite as a string.
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") return null;
    const rec = part as { type?: unknown; text?: unknown };
    if (rec.type !== "text" || typeof rec.text !== "string") return null;
    parts.push(rec.text);
  }
  return parts.join("");
}

export function trimHeadTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const omitted = text.length - head - tail;
  return (
    `${text.slice(0, head)}\n[… ${omitted} chars omitted by free-opencode …]\n` +
    text.slice(text.length - tail)
  );
}

export function compactMessages(
  messages: unknown,
  options: CompactionOptions = DEFAULT_COMPACTION
): { messages: unknown; report: CompactionReport } {
  const report: CompactionReport = { savedChars: 0, trimmed: 0, deduped: 0 };
  if (options.mode === "off" || !Array.isArray(messages)) return { messages, report };

  const seen = new Map<string, string>();
  const out = messages.map((raw: unknown, index) => {
    if (!raw || typeof raw !== "object") return raw;
    const message = raw as ChatMessage;
    if (message.role !== "tool") return raw;
    const text = textOf(message.content);
    if (text === null) return raw;

    let next: string;
    const earlier = text.length >= options.minDedupChars ? seen.get(text) : undefined;
    if (earlier !== undefined) {
      next = `[identical to the earlier tool result ${earlier}; omitted by free-opencode]`;
      report.deduped += 1;
    } else {
      if (text.length >= options.minDedupChars) {
        const id = typeof message.tool_call_id === "string" ? message.tool_call_id : `#${index}`;
        seen.set(text, id);
      }
      next = trimHeadTail(text, options.maxToolChars);
      if (next !== text) report.trimmed += 1;
    }
    if (next === text) return raw;
    report.savedChars += text.length - next.length;
    return { ...message, content: next };
  });
  return { messages: out, report };
}
