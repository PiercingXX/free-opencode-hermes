import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  applyAdminSettingsPatch,
  applyEnvOverrides,
  connectProvider,
  isAdminListed,
  isProviderConfigured,
  isProviderReady,
  loadSettings,
  readyProviderIds,
  removeProvider,
  saveSettings,
  type Settings,
} from "../config/settings.js";
import { allProviders, providerById, providerExtraFields } from "../providers/catalog.js";
import { applyAutofindResults, runAutofind } from "../providers/autofind.js";
import { loadInventoryLanes, suggestedBaseUrl } from "../providers/inventory.js";
import { adminPage } from "./admin.js";
import { buildModelCatalog, modelsListPayload, parseCatalogView, probeProvider } from "./models.js";
import { chatStreamToResponses, chatJsonToResponses, responsesBodyToChat } from "./responses.js";
import { RouteError, routeChat, type ChatRequest } from "./router.js";

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
};

export type RunningProxy = {
  server: Server;
  settings: () => Settings;
  url: string;
  close: () => Promise<void>;
};

function clientAddress(req: IncomingMessage): string {
  return (req.socket.remoteAddress || "").replace("::ffff:", "");
}

function isLoopback(addr: string): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "localhost" || addr === "";
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {}
): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const type =
    typeof body === "string" && body.startsWith("<!")
      ? "text/html; charset=utf-8"
      : "application/json";
  res.writeHead(status, { "Content-Type": type, ...extra });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON object required");
  }
  return parsed as Record<string, unknown>;
}

function normalizeSecret(value: string | undefined): string | null {
  const token = value?.trim() ?? "";
  if (!token) return null;
  if (token === "undefined" || token === "null") return null;
  if (token.startsWith("{env:")) return null;
  return token;
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header?.toLowerCase().startsWith("bearer ")) {
    const token = normalizeSecret(header.slice(7));
    if (token) return token;
  }
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string") return normalizeSecret(apiKey);
  if (Array.isArray(apiKey) && apiKey[0]) return normalizeSecret(apiKey[0]);
  return null;
}

function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function requireProxyAuth(req: IncomingMessage, settings: Settings, res: ServerResponse): boolean {
  if (!settings.proxyAuthEnabled) return true;
  const token = bearerToken(req);
  if (token && tokensEqual(token, settings.proxyAuthToken)) return true;
  // OpenCode often never interpolates {env:FREE_OPENCODE_API_KEY}. The proxy
  // only binds loopback by default, so a missing token from 127.0.0.1 is the
  // local client, not a stranger.
  if (!token && isLoopback(clientAddress(req))) return true;
  send(res, 401, { error: { message: "Unauthorized", type: "authentication_error" } });
  return false;
}

async function handleChat(
  res: ServerResponse,
  settings: Settings,
  body: ChatRequest,
  signal: AbortSignal
): Promise<void> {
  const routed = await routeChat(settings, body, undefined, signal);
  if (body.stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "x-foc-model": routed.used.slug,
    });
    if (!routed.response.body) {
      res.end();
      return;
    }
    const reader = routed.response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) res.write(value);
      }
    } finally {
      reader.releaseLock();
      res.end();
    }
    return;
  }
  const json = (await routed.response.json()) as Record<string, unknown>;
  json.model = routed.used.slug;
  send(res, 200, json, { "x-foc-model": routed.used.slug });
}

export function startProxy(initial?: Settings, home?: string): RunningProxy {
  let settings = applyEnvOverrides(initial ?? loadSettings(home));
  const persist = (): void => {
    saveSettings(settings, home);
  };
  const host = settings.listen.host;
  const port = settings.listen.port;

  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      const addr = clientAddress(req);

      if (url.pathname.startsWith("/admin") && !isLoopback(addr)) {
        send(res, 403, { error: { message: "Admin is loopback-only" } });
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        send(res, 200, { ok: true, service: "free-opencode", builtAt: PROXY_BUILT_AT });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin") {
        send(res, 200, adminPage());
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/api/state") {
        const models = await buildModelCatalog(settings).catch(() => []);
        send(res, 200, {
          listen: settings.listen,
          model: settings.model,
          fallbacks: settings.fallbacks,
          models,
          catalog: allProviders()
            .filter((p) => isAdminListed(settings, p.id))
            .map((p) => ({
              id: p.id,
              name: p.name,
              env: p.env,
              local: Boolean(p.local),
              notes: p.notes ?? "",
              credentialUrl: p.credentialUrl,
              defaultBaseUrl: p.defaultBaseUrl ?? "",
              extra: providerExtraFields(p).map((field) => ({
                key: field.key,
                label: field.label,
                placeholder:
                  field.placeholder ||
                  (field.key === "baseUrl" ? suggestedBaseUrl(p.id) || p.defaultBaseUrl || "" : ""),
                required: Boolean(field.required),
                value: settings.extra[p.id]?.[field.key] ?? "",
              })),
              ready: isProviderReady(settings, p.id),
              configured: isProviderConfigured(settings, p.id),
              discovered: settings.discovered[p.id] ?? [],
            })),
          inventory: loadInventoryLanes().map((lane) => ({
            providerId: lane.providerId,
            label: lane.label,
            endpoint: lane.endpoint,
            enabled: lane.enabled,
            kind: lane.kind,
            scope: lane.scope,
          })),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/api/settings") {
        const patch = await readJson(req);
        settings = applyAdminSettingsPatch(settings, patch);
        persist();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/api/probe") {
        const body = await readJson(req);
        const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
        const provider = providerById(providerId);
        if (!provider) {
          send(res, 400, { error: { message: `Unknown provider '${providerId}'` } });
          return;
        }
        const overlay = applyEnvOverrides({
          ...settings,
          keys: { ...settings.keys },
          extra: { ...settings.extra },
        });
        if (typeof body.apiKey === "string" && body.apiKey.trim()) {
          overlay.keys[providerId] = body.apiKey.trim();
        }
        if (body.extra && typeof body.extra === "object" && !Array.isArray(body.extra)) {
          overlay.extra[providerId] = {
            ...overlay.extra[providerId],
            ...(body.extra as Record<string, string>),
          };
        }
        send(res, 200, await probeProvider(overlay, provider));
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/api/connect") {
        const body = await readJson(req);
        const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
        const provider = providerById(providerId);
        if (!provider) {
          send(res, 400, { error: { message: `Unknown provider '${providerId}'` } });
          return;
        }
        const overlay = applyEnvOverrides({
          ...settings,
          keys: { ...settings.keys },
          extra: { ...settings.extra },
        });
        if (typeof body.apiKey === "string" && body.apiKey.trim()) {
          overlay.keys[providerId] = body.apiKey.trim();
        }
        const extra =
          body.extra && typeof body.extra === "object" && !Array.isArray(body.extra)
            ? (body.extra as Record<string, string>)
            : {};
        overlay.extra[providerId] = { ...overlay.extra[providerId], ...extra };
        const probed = await probeProvider(overlay, provider);
        if (!probed.ok) {
          send(res, 200, probed);
          return;
        }
        settings = connectProvider(overlay, providerId, extra, probed.models);
        persist();
        send(res, 200, {
          ...probed,
          saved: true,
          model: settings.model,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/api/autofind") {
        const report = await runAutofind();
        const applied = applyAutofindResults(settings, report);
        settings = applied.settings;
        persist();
        send(res, 200, {
          ok: true,
          hits: applied.report.hits,
          connected: applied.report.connected,
          notes: applied.report.notes,
          model: settings.model,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/api/remove") {
        const body = await readJson(req);
        const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
        const provider = providerById(providerId);
        if (!provider) {
          send(res, 400, { error: { message: `Unknown provider '${providerId}'` } });
          return;
        }
        settings = removeProvider(settings, providerId);
        persist();
        send(res, 200, {
          ok: true,
          providerId,
          model: settings.model,
          fallbacks: settings.fallbacks,
          ready: readyProviderIds(settings),
        });
        return;
      }

      if (!requireProxyAuth(req, settings, res)) return;

      if (req.method === "GET" && url.pathname === "/v1/models") {
        const view = parseCatalogView(url.searchParams.get("view"));
        const models = await buildModelCatalog(settings, fetch, view);
        send(res, 200, modelsListPayload(models));
        return;
      }

      const ac = new AbortController();
      // IncomingMessage "close" also fires after the body is fully read. Abort
      // only if the client dropped the connection while we still owe a response.
      const abortIfClientGone = (): void => {
        if (!res.writableEnded && !res.writableFinished && !ac.signal.aborted) {
          ac.abort();
        }
      };
      req.on("aborted", abortIfClientGone);
      res.on("close", abortIfClientGone);

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = (await readJson(req)) as ChatRequest;
        await handleChat(res, settings, body, ac.signal);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        const raw = await readJson(req);
        const chat = responsesBodyToChat(raw);
        const routed = await routeChat(
          settings,
          { ...chat, stream: chat.stream !== false },
          undefined,
          ac.signal
        );
        if (chat.stream !== false && routed.response.body) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "x-foc-model": routed.used.slug,
          });
          for await (const chunk of chatStreamToResponses(
            routed.response.body,
            routed.used.slug,
            `resp_${Date.now()}`
          )) {
            res.write(chunk);
          }
          res.end();
          return;
        }
        const json = (await routed.response.json()) as Record<string, unknown>;
        send(res, 200, chatJsonToResponses(json, routed.used.slug));
        return;
      }

      send(res, 404, { error: { message: "Not found" } });
    })().catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof RouteError) {
        send(res, error.status, error.body);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      send(res, 500, { error: { message, type: "internal_error" } });
    });
  });

  server.listen(port, host);

  return {
    server,
    settings: () => settings,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
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
    return { ok: true, service: body.service, builtAt: body.builtAt };
  } catch {
    return null;
  }
}

export async function proxyHealth(url: string, token?: string): Promise<boolean> {
  const health = await fetchProxyHealth(url, token);
  return Boolean(health?.ok);
}

export function isStaleProxy(health: ProxyHealth | null, localBuiltAt: number): boolean {
  if (!health?.ok || localBuiltAt <= 0) return false;
  if (typeof health.builtAt !== "number") return true;
  return health.builtAt + 1500 < localBuiltAt;
}
