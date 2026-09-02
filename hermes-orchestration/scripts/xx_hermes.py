#!/usr/bin/env python3
"""Launch Hermes Agent against the local hermes-orchestration proxy (Linux + Windows)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
HERMES_DIR = HERE.parent
TOKEN_FILE = Path(
    os.environ.get(
        "HERMES_PROXY_ENV_FILE",
        str(Path.home() / ".config" / "hermes-orchestration" / "proxy.env"),
    )
)


def load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def proxy_port() -> int:
    config_path = HERMES_DIR / "config" / "orchestration.json"
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
        return int(payload.get("proxy", {}).get("port", 8180))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return 8180


def healthy(url: str) -> bool:
    try:
        with urllib.request.urlopen(url + "/healthz", timeout=1.5) as response:
            return 200 <= response.status < 300
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def start_proxy(env: dict[str, str]) -> None:
    orchestrator = HERMES_DIR / "scripts" / "hermes_orchestrator.py"
    creationflags = 0
    start_new_session = True
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(
            subprocess, "DETACHED_PROCESS", 0
        )
        start_new_session = False
    subprocess.Popen(
        [sys.executable, str(orchestrator), "serve"],
        cwd=str(HERMES_DIR),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=env,
        creationflags=creationflags,
        start_new_session=start_new_session,
    )


def write_managed_config(directory: Path, url: str) -> None:
    config = {
        "providers": {
            "xx_stack": {
                "name": "xx-stack (Hermes orchestration)",
                "api": f"{url}/v1",
                "key_env": "HERMES_PROXY_TOKEN",
                "extra_headers": {"Authorization": "Bearer ${HERMES_PROXY_TOKEN}"},
                "default_model": "hermes-auto",
                "models": {"hermes-auto": {}},
                "discover_models": True,
            }
        },
        "model": {
            "provider": "custom:xx_stack",
            "default": "hermes-auto",
            "base_url": "",
            "api_key": "",
        },
    }
    path = directory / "config.yaml"
    path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    file_env = load_env_file(TOKEN_FILE)
    env = os.environ.copy()
    env.update(file_env)
    token = env.get("HERMES_PROXY_TOKEN", "").strip()
    if not token:
        print(f"error: HERMES_PROXY_TOKEN is empty. Write it to {TOKEN_FILE}", file=sys.stderr)
        return 1

    hermes = shutil.which("hermes") or shutil.which("hermes.exe")
    if not hermes:
        print("error: Hermes Agent is not on PATH. Re-run install-hermes.", file=sys.stderr)
        return 1

    url = f"http://127.0.0.1:{proxy_port()}"
    if not healthy(url):
        print(f"starting hermes-orchestration proxy on {url}", file=sys.stderr)
        start_proxy(env)
        for _ in range(20):
            if healthy(url):
                break
            time.sleep(0.2)

    managed = Path(tempfile.mkdtemp(prefix="xx-hermes-"))
    try:
        write_managed_config(managed, url)
        env["HERMES_MANAGED_DIR"] = str(managed)
        return subprocess.call(
            [hermes, "--provider", "custom:xx_stack", "--model", "hermes-auto", *sys.argv[1:]],
            env=env,
        )
    finally:
        shutil.rmtree(managed, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
