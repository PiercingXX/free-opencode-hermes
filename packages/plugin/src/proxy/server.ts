import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { applyEnvOverrides, loadSettings, type Settings } from "../config/settings.js";
import { adminPage } from "./admin.js";
import { ADMIN_ROUTES, routingHealth } from "./admin-api.js";
import { compactionMode } from "./compact.js";
import { loadCooldowns } from "./cooldown.js";
import {
  HttpError,
  MAX_ADMIN_BODY_BYTES,
  MAX_API_BODY_BYTES,
  SSE_HEADERS,
  assertTrustedRequest,
  bearerToken,
  clientAddress,
  isLoopback,
  pipeToClient,
  readBody,
  readJson,
  send,
  sendError,
  tokensEqual,
} from "./http.js";
import { buildModelCatalog, modelsListPayload, parseCatalogView } from "./models.js";
import { chatJsonToResponses, chatStreamToResponses, responsesBodyToChat } from "./responses.js";
import {
  RouteError,
  routeChat,
  type ChatRequest,
  type RouteHopInfo,
  type RoutedResult,
} from "./router.js";
import {
  appendLog,
  currentLastRoute,
  logRoute,
  type LastRoute,
  type RouteHopRecord,
} from "./route-log.js";
import { SettingsStore } from "./settings-store.js";

const PROXY_BUILT_AT: number = ((): number => {
  try {
    return statSync(fileURLToPath(import.meta.url)).mtimeMs;
  } catch {
    return Date.now();
  }
})();

export type ProxyHealth = {
  ok: boolean;
  service?: string;
  builtAt?: number;
  pid?: number;
  lastRoute?: LastRoute;
  cooldowns?: Array<{
    slug: string;
    providerId: string;
    availableAt: number;
    reason?: string;
  }>;
};

export type RunningProxy = {
  server: Server;
  settings: () => Settings;
  url: string;
  /** Per-process secret the Admin page sends as `x-foc-admin`. */
  adminToken: string;
  close: () => Promise<void>;
};

let requestSeq = 0;
function newRequestId(): string {
  requestSeq += 1;
  return `req_${Date.now().toString(36)}_${requestSeq}`;
}

/**
 * /v1 auth. A request without any token from loopback is allowed: OpenCode
 * often never interpolates {env:FREE_OPENCODE_API_KEY}. That is only safe
 * because assertTrustedRequest already rejected browser-originated traffic.
 */
function requireProxyAuth(req: IncomingMessage, settings: Settings): void {
  if (!settings.proxyAuthEnabled) return;
  const token = bearerToken(req);
  if (token && tokensEqual(token, settings.proxyAuthToken)) return;
  if (!token && isLoopback(clientAddress(req))) return;
  throw new HttpError(401, "Unauthorized", "authentication_error");
}

/** Admin: loopback only, and either the page's admin token or the proxy token. */
function requireAdminAuth(req: IncomingMessage, settings: Settings, adminToken: string): void {
  if (!isLoopback(clientAddress(req)))
    throw new HttpError(403, "Admin is loopback-only", "forbidden");
  const header = req.headers["x-foc-admin"];
  const supplied = Array.isArray(header) ? header[0] : header;
  if (supplied && tokensEqual(supplied, adminToken)) return;
  const bearer = bearerToken(req);
  if (bearer && tokensEqual(bearer, settings.proxyAuthToken)) return;
  throw new HttpError(401, "Admin token required", "authentication_error");
}

function hopRecord(
  requestId: string,
  hop: Pick<
    RouteHopInfo,
    "slug" | "providerId" | "status" | "latencyMs" | "ok" | "fallback" | "tried"
  >
): RouteHopRecord {
  return { at: new Date().toISOString(), requestId, ...hop };
}

/** Route one chat request through the fallback chain, logging every hop and the result. */
async function routeLogged(
  store: SettingsStore,
  body: ChatRequest,
  req: IncomingMessage,
  signal: AbortSignal,
  home: string
): Promise<RoutedResult> {
  const requestId = newRequestId();
  let lastHop: RouteHopInfo | null = null;
  try {
    const routed = await routeChat(store.get(), body, undefined, {
      signal,
      home,
      compaction: compactionMode(req.headers["x-foc-compaction"]),
      onHop: (hop) => {
        lastHop = hop;
        void logRoute(home, { ...hop, requestId }, "route.attempt");
      },
      onLearned: (delta) => store.learnAccess(delta),
    });
    await logRoute(
      home,
      {
        ...hopRecord(requestId, {
          slug: routed.used.slug,
          providerId: routed.used.providerId,
          status: 200,
          latencyMs: routed.latencyMs,
          ok: true,
          fallback: routed.fallback,
          tried: routed.tried,
        }),
        ...(routed.compaction.savedChars > 0 ? { compaction: routed.compaction } : {}),
      },
      "route.result"
    );
    return routed;
  } catch (error) {
    // Assigned inside the onHop closure; TS cannot see that and narrows to null.
    const hop = lastHop as RouteHopInfo | null;
    await logRoute(
      home,
      {
        ...hopRecord(requestId, {
          slug: hop?.slug ?? body.model,
          providerId: hop?.providerId ?? "",
          status: error instanceof RouteError ? error.status : null,
          latencyMs: hop?.latencyMs ?? 0,
          ok: false,
          fallback: hop ? hop.fallback : false,
          tried: hop?.tried ?? [],
        }),
        message: error instanceof Error ? error.message : String(error),
      },
      "route.result"
    );
    throw error;
  }
}

function routedHeaders(routed: RoutedResult): Record<string, string> {
  return {
    "x-foc-model": routed.used.slug,
    ...(routed.compaction.savedChars > 0
      ? { "x-foc-compacted-chars": String(routed.compaction.savedChars) }
      : {}),
  };
}

async function handleChatCompletions(
  res: ServerResponse,
  routed: RoutedResult,
  stream: boolean
): Promise<void> {
  if (!stream) {
    const json = (await routed.response.json()) as Record<string, unknown>;
    json.model = routed.used.slug;
    send(res, 200, json, routedHeaders(routed));
    return;
  }
  res.writeHead(200, { ...SSE_HEADERS, ...routedHeaders(routed) });
  if (routed.response.body) await pipeToClient(res, readBody(routed.response.body));
  res.end();
}

async function handleResponses(
  res: ServerResponse,
  routed: RoutedResult,
  stream: boolean
): Promise<void> {
  if (!stream) {
    const json = (await routed.response.json()) as Record<string, unknown>;
    send(res, 200, chatJsonToResponses(json, routed.used.slug), routedHeaders(routed));
    return;
  }
  if (!routed.response.body) {
    throw new RouteError(`${routed.used.slug} returned an empty stream`, 502);
  }
  res.writeHead(200, { ...SSE_HEADERS, ...routedHeaders(routed) });
  await pipeToClient(
    res,
    chatStreamToResponses(routed.response.body, routed.used.slug, `resp_${Date.now()}`)
  );
  res.end();
}

/** Abort upstream work when the client hangs up before we finish responding. */
function clientAbortSignal(req: IncomingMessage, res: ServerResponse): AbortSignal {
  const ac = new AbortController();
  // IncomingMessage "close" also fires after the body is fully read, so only
  // abort while a response is still owed.
  const abortIfClientGone = (): void => {
    if (!res.writableEnded && !res.writableFinished && !ac.signal.aborted) ac.abort();
  };
  req.on("aborted", abortIfClientGone);
  res.on("close", abortIfClientGone);
  return ac.signal;
}

function sendFailure(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof HttpError) {
    sendError(res, error.status, error.message, error.type);
  } else if (error instanceof RouteError) {
    send(res, error.status, error.body);
  } else {
    sendError(res, 500, error instanceof Error ? error.message : String(error), "internal_error");
  }
}

export function startProxy(initial?: Settings, home: string = homedir()): RunningProxy {
  const store = new SettingsStore(applyEnvOverrides(initial ?? loadSettings(home)), home);
  // Restore cooldowns from the previous process so a restart does not re-hit a
  // model that was 402/429'd. Expired windows are dropped on load.
  loadCooldowns(home);
  const { host, port } = store.get().listen;
  const adminToken = randomBytes(24).toString("hex");

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    assertTrustedRequest(req, host);
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/health") {
      send(res, 200, {
        ok: true,
        service: "free-opencode",
        builtAt: PROXY_BUILT_AT,
        pid: process.pid,
        lastRoute: currentLastRoute(),
        ...routingHealth(),
      });
      return;
    }

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      if (!isLoopback(clientAddress(req))) {
        throw new HttpError(403, "Admin is loopback-only", "forbidden");
      }
      if (method === "GET" && url.pathname === "/admin") {
        send(res, 200, adminPage(adminToken));
        return;
      }
      const handler = ADMIN_ROUTES[`${method} ${url.pathname}`];
      if (!handler) throw new HttpError(404, "Not found", "not_found");
      requireAdminAuth(req, store.get(), adminToken);
      const body = method === "POST" ? await readJson(req, MAX_ADMIN_BODY_BYTES) : {};
      send(res, 200, await handler({ store, home, body, query: url.searchParams }));
      return;
    }

    requireProxyAuth(req, store.get());

    if (method === "GET" && url.pathname === "/v1/models") {
      const view = parseCatalogView(url.searchParams.get("view"));
      send(res, 200, modelsListPayload(await buildModelCatalog(store.get(), fetch, view)));
      return;
    }

    if (method === "POST" && url.pathname === "/v1/chat/completions") {
      const signal = clientAbortSignal(req, res);
      const body = (await readJson(req, MAX_API_BODY_BYTES)) as ChatRequest;
      const routed = await routeLogged(store, body, req, signal, home);
      await handleChatCompletions(res, routed, Boolean(body.stream));
      return;
    }

    if (method === "POST" && url.pathname === "/v1/responses") {
      const signal = clientAbortSignal(req, res);
      const chat = responsesBodyToChat(await readJson(req, MAX_API_BODY_BYTES));
      const stream = chat.stream !== false;
      const routed = await routeLogged(store, { ...chat, stream }, req, signal, home);
      await handleResponses(res, routed, stream);
      return;
    }

    throw new HttpError(404, "Not found", "not_found");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => sendFailure(res, error));
  });
  server.listen(port, host);

  void appendLog(
    "proxy.start",
    { listen: { host, port }, pid: process.pid, builtAt: PROXY_BUILT_AT },
    home
  );

  return {
    server,
    settings: () => store.get(),
    url: `http://${host}:${port}`,
    adminToken,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          void appendLog("proxy.stop", { pid: process.pid }, home);
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

export async function waitForListen(proxy: RunningProxy): Promise<void> {
  const server = proxy.server;
  if (server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
}

export async function fetchProxyHealth(url: string, token?: string): Promise<ProxyHealth | null> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as ProxyHealth;
    return {
      ok: true,
      service: body.service,
      builtAt: body.builtAt,
      pid: body.pid,
      lastRoute: body.lastRoute,
      cooldowns: body.cooldowns,
    };
  } catch {
    return null;
  }
}

export function isStaleProxy(health: ProxyHealth | null, localBuiltAt: number): boolean {
  if (!health?.ok || localBuiltAt <= 0) return false;
  if (typeof health.builtAt !== "number") return true;
  return health.builtAt + 1500 < localBuiltAt;
}
