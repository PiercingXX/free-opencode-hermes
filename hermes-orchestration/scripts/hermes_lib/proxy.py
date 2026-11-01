"""Loopback OpenAI-compatible proxy fronting the routing policy."""

from __future__ import annotations

import argparse
import hmac
import ipaddress
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple

from .inventory import log_routing_event, routing_event
from .lanes import (
    LANE_HEALTH_TTL_SECONDS,
    ApiKeyCommandError,
    Lane,
    LaneHealthCache,
    OrchestratorError,
    http_json,
    http_open,
    is_cloud_lane,
    join_text_parts,
    lane_chat_url,
    lane_from_config,
    lane_model_candidates,
    ordered_lane_keys,
    parse_chat_content,
    request_timeout,
    resolve_api_key,
    run_hermes_cli_oneshot,
)
from .routing import model_matches_requirement, primary_lane_order


PROXY_PASSTHROUGH_KEYS = (
    "messages",
    "temperature",
    "top_p",
    "max_tokens",
    "tools",
    "tool_choice",
    "stop",
    "response_format",
    "frequency_penalty",
    "presence_penalty",
    "seed",
)


class ProxyServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, handler, cfg, token, allow_cloud):
        super().__init__(address, handler)
        self.cfg = cfg
        self.token = token
        self.allow_cloud = allow_cloud
        proxy_cfg = cfg.get("proxy", {}) if isinstance(cfg.get("proxy"), dict) else {}
        self.health_cache = LaneHealthCache(
            int(proxy_cfg.get("health_check_ttl_seconds", LANE_HEALTH_TTL_SECONDS))
        )


def flatten_messages_for_cli(messages: List[Dict[str, Any]]) -> str:
    parts: List[str] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role", "user"))
        content = message.get("content")
        if isinstance(content, list):
            text = join_text_parts(content)
        else:
            text = str(content or "")
        parts.append(f"{role}: {text}")
    return "\n\n".join(parts)


MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024
REQUEST_SOCKET_TIMEOUT_SECONDS = 30
_DRAIN_CHUNK_BYTES = 64 * 1024


# (completion data, open upstream stream or None, model that served it)
ServedCompletion = Tuple[Dict[str, Any], Any, str]


def proxy_lane_order(cfg: Dict[str, Any], requested_model: str) -> List[str]:
    """Primary lane order, narrowed to lanes serving an explicitly named model.

    "auto" (or an unmatched name) keeps every primary lane eligible.
    """
    order = primary_lane_order(cfg)
    if requested_model in ("auto", "", "hermes-orchestrator"):
        return order
    matching = []
    for key in order:
        lane = lane_from_config(cfg, key)
        if model_matches_requirement(requested_model, lane_model_candidates(lane), lane.model):
            matching.append(key)
    return matching or order


def serve_via_hermes_cli(cfg: Dict[str, Any], lane: Lane, messages: List[Any]) -> Optional[ServedCompletion]:
    """Run the flattened conversation through the hermes CLI, trying each model."""
    prompt = flatten_messages_for_cli(messages)
    for candidate_model in lane_model_candidates(lane):
        ok, detail = run_hermes_cli_oneshot(lane, request_timeout(cfg), candidate_model, prompt)
        if not ok:
            continue
        data = {
            "id": f"chatcmpl-hermes-{int(time.time() * 1000)}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": candidate_model,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": detail},
                    "finish_reason": "stop",
                }
            ],
            "usage": {},
        }
        return data, None, candidate_model
    return None


def serve_via_http(
    cfg: Dict[str, Any],
    lane: Lane,
    payload: Dict[str, Any],
    stream: bool,
    attempts: List[str],
) -> Optional[ServedCompletion]:
    """Forward the request upstream, trying each model; failures go to ``attempts``."""
    forward = {key: payload[key] for key in PROXY_PASSTHROUGH_KEYS if key in payload}
    try:
        api_key = resolve_api_key(lane)
    except ApiKeyCommandError:
        attempts.append(f"{lane.name}:api_key_command_failed")
        return None
    for candidate_model in lane_model_candidates(lane):
        forward["model"] = candidate_model
        if stream:
            forward["stream"] = True
            status, upstream = http_open(
                "POST", lane_chat_url(lane), forward, request_timeout(cfg), api_key or None
            )
            if status < 400:
                return {"model": candidate_model, "usage": {}}, upstream, candidate_model
        else:
            status, upstream = http_json(
                "POST", lane_chat_url(lane), forward, request_timeout(cfg), api_key or None
            )
            if status < 400:
                return upstream, None, str(upstream.get("model", lane.model))
        attempts.append(f"{lane.name}:{candidate_model}:http_{status}")
        if status in (401, 403, 404):
            # Auth and missing-endpoint failures are lane problems: every
            # fallback model hits the same credentials and URL, so retrying
            # them cannot succeed.
            break
    return None


def log_proxy_event(
    cfg: Dict[str, Any],
    lane: Optional[Lane],
    model: str,
    requested_model: str,
    stream: bool,
    attempts: List[str],
    latency_ms: Optional[int] = None,
    usage: Optional[Dict[str, Any]] = None,
    error: str = "",
) -> None:
    """One routing.jsonl record per proxied request; ``lane`` None means total failure."""
    log_routing_event(
        cfg,
        routing_event(
            "proxy", lane, model, ok=lane is not None, latency_ms=latency_ms, usage=usage, error=error,
            extra={
                "requested_model": requested_model,
                "stream": stream,
                # Reasons every earlier lane was skipped or failed. Empty when
                # the first lane served the request (HERMES-DOC-1).
                "attempts": list(attempts),
            },
        ),
    )


class ProxyHandler(BaseHTTPRequestHandler):
    server: ProxyServer  # narrowed type for attribute access

    protocol_version = "HTTP/1.1"
    # StreamRequestHandler.setup() applies this to the connection socket. Without
    # it a client that sends headers and then stalls parks a handler thread
    # forever (HERMES-6).
    timeout = REQUEST_SOCKET_TIMEOUT_SECONDS

    def log_message(self, format: str, *log_args: Any) -> None:  # noqa: A002
        # Suppress per-request stderr noise; routing telemetry covers requests.
        pass

    def _send_json(self, code: int, obj: Dict[str, Any], close: bool = False) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(body)

    def _content_length(self) -> int:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return -1
        return length if length >= 0 else -1

    def _drain_request_body(self) -> bool:
        """Consume the request body so keep-alive stays in sync.

        With HTTP/1.1 keep-alive an undrained body is parsed as the next request
        line (HERMES-5). Returns False when the body is too large to drain, in
        which case the caller must close the connection instead.
        """
        length = self._content_length()
        if length <= 0:
            return True
        if length > MAX_REQUEST_BODY_BYTES:
            return False
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(_DRAIN_CHUNK_BYTES, remaining))
            if not chunk:
                return False
            remaining -= len(chunk)
        return True

    def _reject(self, code: int, message: str) -> None:
        """Answer an early-return error, keeping the connection consistent."""
        drained = self._drain_request_body()
        self._send_json(code, {"error": {"message": message}}, close=not drained)

    def _authorized(self) -> bool:
        if self.server.token is None:
            return True
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        # Compare bytes: hmac.compare_digest on str raises TypeError for any
        # non-ASCII input, which crashed the handler thread pre-auth (HERMES-3).
        presented = header[len("Bearer "):].strip().encode("utf-8", errors="surrogateescape")
        expected = str(self.server.token).encode("utf-8", errors="surrogateescape")
        return hmac.compare_digest(presented, expected)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self._send_json(200, {"status": "ok"})
            return
        if not self._authorized():
            self._reject(401, "missing or invalid bearer token")
            return
        if self.path == "/v1/models":
            cfg = self.server.cfg
            model_ids: List[str] = ["auto"]
            for key in ordered_lane_keys(cfg):
                lane = lane_from_config(cfg, key)
                if not lane.enabled:
                    continue
                for candidate in lane_model_candidates(lane):
                    if candidate not in model_ids:
                        model_ids.append(candidate)
            data = [{"id": model_id, "object": "model", "owned_by": "hermes-orchestrator"} for model_id in model_ids]
            self._send_json(200, {"object": "list", "data": data})
            return
        self._reject(404, f"unknown path {self.path}")

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorized():
            self._reject(401, "missing or invalid bearer token")
            return
        if self.path != "/v1/chat/completions":
            self._reject(404, f"unknown path {self.path}")
            return

        payload = self._read_json_body()
        if payload is None:
            return
        messages = payload.get("messages")
        if not isinstance(messages, list) or not messages:
            self._send_json(400, {"error": {"message": "'messages' must be a non-empty list"}})
            return

        cfg = self.server.cfg
        requested_model = str(payload.get("model") or "auto")
        stream = bool(payload.get("stream", False))

        attempts: List[str] = []
        for lane_key in proxy_lane_order(cfg, requested_model):
            lane = lane_from_config(cfg, lane_key)
            if not lane.enabled:
                continue
            skip_reason = self._lane_skip_reason(cfg, lane_key, lane)
            if skip_reason:
                attempts.append(f"{lane.name}:{skip_reason}")
                continue

            start = time.monotonic()
            if lane.endpoint_type == "hermes_cli":
                served = serve_via_hermes_cli(cfg, lane, messages)
                if served is None:
                    attempts.append(f"{lane.name}:cli_failed")
                    continue
            else:
                served = serve_via_http(cfg, lane, payload, stream, attempts)
                if served is None:
                    continue
            data, stream_handle, model_used = served

            usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
            log_proxy_event(
                cfg, lane, model_used, requested_model, stream, attempts,
                latency_ms=int((time.monotonic() - start) * 1000), usage=usage,
            )
            if stream_handle is not None:
                self._relay_upstream_stream(stream_handle, model_used)
            elif stream:
                self._send_stream_shim(data, model_used)
            else:
                self._send_json(200, data)
            return

        # Total failure used to write no telemetry at all, so failed requests were
        # invisible in routing.jsonl (HERMES-12).
        log_proxy_event(
            cfg, None, requested_model, requested_model, stream, attempts,
            error="no lane could serve the request",
        )
        self._send_json(
            502,
            {"error": {"message": "no lane could serve the request", "attempts": attempts}},
        )

    def _read_json_body(self) -> Optional[Dict[str, Any]]:
        """Read and parse the request body; on failure answer the client and return None."""
        length = self._content_length()
        if length < 0:
            self._send_json(400, {"error": {"message": "invalid Content-Length"}}, close=True)
            return None
        if length > MAX_REQUEST_BODY_BYTES:
            # Do not read it; answer and close rather than stream megabytes we
            # already know we will discard (HERMES-6).
            self._send_json(
                413,
                {"error": {"message": f"request body exceeds {MAX_REQUEST_BODY_BYTES} bytes"}},
                close=True,
            )
            return None
        try:
            raw = self.rfile.read(length) if length else b""
            if len(raw) != length:
                self._send_json(400, {"error": {"message": "truncated request body"}}, close=True)
                return None
            return json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, json.JSONDecodeError, OSError):
            self._send_json(400, {"error": {"message": "invalid JSON body"}}, close=True)
            return None

    def _lane_skip_reason(self, cfg: Dict[str, Any], lane_key: str, lane: Lane) -> str:
        """Why an enabled lane must not serve this request, or "" when it may."""
        if is_cloud_lane(cfg, lane_key):
            return "" if self.server.allow_cloud else "cloud_not_allowed"
        ok, reason = self.server.health_cache.get(cfg, lane)
        return "" if ok else f"unhealthy:{reason}"

    def _relay_upstream_stream(self, resp: Any, model_used: str) -> None:
        """Copy an upstream SSE body, or wrap a JSON completion in the shim."""
        try:
            content_type = str(getattr(resp, "headers", {}).get("Content-Type") or "").lower()
            if "event-stream" in content_type:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.close_connection = True
                self.end_headers()
                while True:
                    chunk = resp.read(4096)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
                return
            raw = resp.read()
            try:
                parsed = json.loads(raw.decode("utf-8")) if raw else {}
            except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
                parsed = {}
            if not isinstance(parsed, dict):
                parsed = {}
            self._send_stream_shim(parsed, str(parsed.get("model", model_used)))
        finally:
            close = getattr(resp, "close", None)
            if callable(close):
                close()

    def _send_stream_shim(self, data: Dict[str, Any], model_used: str) -> None:
        """Non-streaming completion delivered as minimal SSE for stream clients."""
        try:
            content = parse_chat_content("proxy", data)
        except OrchestratorError:
            content = ""
        completion_id = str(data.get("id", f"chatcmpl-hermes-{int(time.time() * 1000)}"))
        created = int(data.get("created", time.time()))

        def chunk(delta: Dict[str, Any], finish_reason: Optional[str]) -> bytes:
            body = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model_used,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
            }
            return f"data: {json.dumps(body)}\n\n".encode("utf-8")

        frames = (
            chunk({"role": "assistant"}, None)
            + chunk({"content": content}, None)
            + chunk({}, "stop")
            + b"data: [DONE]\n\n"
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(frames)))
        self.end_headers()
        self.wfile.write(frames)


def is_loopback_host(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def check_bind_policy(host: str, token: Optional[str], allow_remote: bool) -> None:
    """Enforce loopback-only exposure (policy), failing closed.

    Non-loopback without auth would be an unauthenticated LAN relay to every
    lane, so it is refused outright. Non-loopback with auth still needs an
    explicit --allow-remote.
    """
    if is_loopback_host(host):
        return
    if token is None:
        raise OrchestratorError(
            f"Refusing to bind non-loopback host {host} with auth disabled: that is an "
            "unauthenticated relay. Bind 127.0.0.1 or configure a token."
        )
    if not allow_remote:
        raise OrchestratorError(
            f"Refusing to bind non-loopback host {host}: policy requires loopback-only "
            "exposure. Pass --allow-remote to override (auth stays required)."
        )
    print(
        f"WARNING: proxy binding to non-loopback host {host} (--allow-remote). "
        "Bearer auth is the only protection.",
        file=sys.stderr,
    )


def command_serve(args: argparse.Namespace, cfg: Dict[str, Any]) -> int:
    proxy_cfg = cfg.get("proxy", {}) if isinstance(cfg.get("proxy"), dict) else {}
    host = args.host or str(proxy_cfg.get("bind_host", "127.0.0.1"))
    port = int(args.port or proxy_cfg.get("port", 8180))
    allow_cloud = bool(args.allow_cloud or proxy_cfg.get("allow_cloud", False))

    token: Optional[str] = args.token or os.environ.get(str(proxy_cfg.get("auth_token_env", "HERMES_PROXY_TOKEN")), "")
    if not token:
        token = None
    if token is None and not args.no_auth:
        raise OrchestratorError(
            "No proxy auth token. Set the env var named by proxy.auth_token_env "
            "(default HERMES_PROXY_TOKEN), pass --token, or explicitly pass --no-auth."
        )

    check_bind_policy(host, token, bool(getattr(args, "allow_remote", False)))

    # No prompt-logging switch exists by design: request bodies are never written
    # anywhere, so there is nothing to gate (HERMES-9).
    server = ProxyServer((host, port), ProxyHandler, cfg, token, allow_cloud)
    actual_port = server.server_address[1]
    print(
        json.dumps(
            {
                "listening": f"http://{host}:{actual_port}",
                "auth": "bearer_token" if token else "DISABLED",
                "allow_cloud": allow_cloud,
                "endpoints": ["/healthz", "/v1/models", "/v1/chat/completions"],
            },
            indent=2,
        ),
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("shutting down", file=sys.stderr)
    finally:
        server.server_close()
    return 0
