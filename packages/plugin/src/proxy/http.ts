/**
 * HTTP plumbing for the proxy: request guards, body parsing with limits,
 * JSON responses and backpressure-aware streaming.
 *
 * Threat model. The proxy listens on loopback and holds provider API keys.
 * "The request came from 127.0.0.1" is NOT proof the user sent it: any web
 * page open in the user's browser can send requests to loopback. Guards:
 *
 *   - Host allowlist (blocks DNS rebinding): a rebinding attack always
 *     arrives with the attacker's domain in Host. Only localhost names, IP
 *     literals, the configured listen host and FREE_OPENCODE_ALLOWED_HOSTS
 *     are accepted.
 *   - Origin check (blocks cross-site requests): browsers attach Origin to
 *     cross-origin requests; any Origin that is not an allowed host is
 *     rejected. Native clients (OpenCode, Hermes, curl) send none.
 *   - JSON-only POST bodies: a browser can only send `text/plain` /
 *     form bodies cross-origin without a CORS preflight, which this server
 *     never answers. Requiring application/json closes that path even if
 *     a browser omits Origin.
 */

import { once } from "node:events";
import { isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type = "invalid_request_error"
  ) {
    super(message);
  }
}

/** /v1 bodies carry whole conversations, sometimes with base64 images. */
export const MAX_API_BODY_BYTES = 32 * 1024 * 1024;
export const MAX_ADMIN_BODY_BYTES = 1024 * 1024;

export function clientAddress(req: IncomingMessage): string {
  return (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}

export function isLoopback(addr: string): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "localhost" || addr === "";
}

function hostnameOf(hostHeader: string): string {
  const raw = hostHeader.trim().toLowerCase();
  if (raw.startsWith("[")) return raw.slice(1, raw.indexOf("]"));
  const colon = raw.lastIndexOf(":");
  return colon > 0 && raw.indexOf(":") === colon ? raw.slice(0, colon) : raw;
}

function extraAllowedHosts(): string[] {
  return (process.env.FREE_OPENCODE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedHostname(hostname: string, listenHost: string): boolean {
  const name = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!name) return false;
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  // DNS rebinding needs a domain name; a literal IP cannot be rebound.
  if (isIP(name) !== 0) return true;
  if (name === listenHost.trim().toLowerCase()) return true;
  return extraAllowedHosts().includes(name);
}

/** Throws 403 when Host or Origin point anywhere but this machine. */
export function assertTrustedRequest(req: IncomingMessage, listenHost: string): void {
  const host = req.headers.host;
  if (host && !isAllowedHostname(hostnameOf(host), listenHost)) {
    throw new HttpError(403, `Host '${host}' is not allowed`, "forbidden");
  }
  const origin = req.headers.origin;
  if (origin === undefined) return;
  let originHost = "";
  try {
    originHost = new URL(origin).hostname.replace(/^\[|\]$/g, "");
  } catch {
    // "null" (sandboxed iframe, file://) and garbage fall through to reject
  }
  if (!originHost || !isAllowedHostname(originHost, listenHost)) {
    throw new HttpError(403, `Origin '${origin}' is not allowed`, "forbidden");
  }
}

function isJsonContentType(value: string | undefined): boolean {
  const type = (value ?? "").split(";")[0].trim().toLowerCase();
  return type === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(type);
}

/** Read a JSON object body. Rejects non-JSON content types and oversized bodies. */
export async function readJson(
  req: IncomingMessage,
  limit: number
): Promise<Record<string, unknown>> {
  const tooLarge = (): HttpError => {
    // Discard (never buffer) whatever is still in flight so the client can
    // read our 413 instead of hitting EPIPE mid-upload.
    req.resume();
    return new HttpError(413, `Request body exceeds ${limit} bytes`, "request_too_large");
  };
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > limit) throw tooLarge();
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  if (!isJsonContentType(req.headers["content-type"])) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new HttpError(400, `Invalid JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "JSON object required");
  }
  return parsed as Record<string, unknown>;
}

export function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {}
): void {
  const html = typeof body === "string" && body.startsWith("<!");
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": html ? "text/html; charset=utf-8" : "application/json",
    "Cache-Control": "no-store",
    ...(html ? { "Content-Security-Policy": "frame-ancestors 'none'" } : {}),
    ...extra,
  });
  res.end(payload);
}

export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  type: string
): void {
  send(res, status, { error: { message, type } });
}

function normalizeSecret(value: string | undefined): string | null {
  const token = value?.trim() ?? "";
  if (!token || token === "undefined" || token === "null") return null;
  // OpenCode sometimes forwards an un-interpolated `{env:NAME}` literally.
  if (token.startsWith("{env:")) return null;
  return token;
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header?.toLowerCase().startsWith("bearer ")) {
    const token = normalizeSecret(header.slice(7));
    if (token) return token;
  }
  const apiKey = req.headers["x-api-key"];
  return normalizeSecret(Array.isArray(apiKey) ? apiKey[0] : apiKey);
}

export function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

/**
 * Write chunks to the client honoring backpressure: wait for `drain` when
 * the socket buffer is full, and stop (returning false) once the client is
 * gone so the caller can cancel the upstream.
 */
export async function pipeToClient(
  res: ServerResponse,
  chunks: AsyncIterable<Uint8Array | string>
): Promise<boolean> {
  for await (const chunk of chunks) {
    if (res.destroyed || res.writableEnded) return false;
    if (!res.write(chunk)) {
      const drained = await Promise.race([
        once(res, "drain").then(() => true),
        once(res, "close").then(() => false),
      ]);
      if (!drained) return false;
    }
  }
  return true;
}

/** Iterate a fetch body; cancelling the reader when the consumer stops early. */
export async function* readBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
