#!/usr/bin/env bash
# Install Hermes Agent plus this repo's hermes-orchestration control plane.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/install-common.sh
. "$SCRIPT_DIR/scripts/install-common.sh"

ROOT="$(repo_root)"
SKIP_HERMES_BIN=0
ENABLE_SYSTEMD=1

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-hermes) SKIP_HERMES_BIN=1; shift ;;
    --no-systemd) ENABLE_SYSTEMD=0; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: ./install-hermes.sh [--skip-hermes] [--no-systemd]

Installs Hermes Agent, generates lanes from inventory.json, installs the
loopback orchestration proxy, and puts `xx-hermes` on PATH.

  --skip-hermes   Do not download Hermes Agent (use an existing install)
  --no-systemd    Skip user-systemd units; start the proxy in the foreground docs
EOF
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

if have python3; then
  PYTHON_BIN=python3
elif have python; then
  PYTHON_BIN=python
else
  die "Python 3 is required (python3 or python on PATH)"
fi
require_node
seed_inventory "$ROOT"
npm_bootstrap "$ROOT"
sync_inventory "$ROOT"

mkdir -p "$ROOT/hermes-orchestration/logs"

if [ "$SKIP_HERMES_BIN" -eq 0 ]; then
  if have hermes; then
    info "Hermes Agent already on PATH: $(command -v hermes)"
  else
    info "installing Hermes Agent"
    curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
    hash -r || true
    have hermes || warn "Hermes installer finished but 'hermes' is not on PATH yet — open a new shell"
  fi
fi

info "wiring token file and xx-hermes launcher"
node "$ROOT/scripts/host-setup.mjs" hermes-host
TOKEN_FILE="$HOME/.config/hermes-orchestration/proxy.env"

if [ "$ENABLE_SYSTEMD" -eq 1 ] && have systemctl; then
  info "installing hermes-orchestration systemd user units"
  "$ROOT/hermes-orchestration/scripts/install_systemd_units.sh"
  info "enabling hermes-proxy.service"
  systemctl --user daemon-reload
  systemctl --user enable --now hermes-proxy.service || warn "could not enable hermes-proxy.service"
  systemctl --user enable --now hermes-capability-refresh.timer || warn "could not enable capability-refresh timer"
else
  info "no systemd — xx-hermes will start the loopback proxy on demand"
fi

info "running Hermes orchestrator unit tests"
(cd "$ROOT/hermes-orchestration" && "$PYTHON_BIN" -m unittest discover -s tests)

cat <<EOF

Hermes setup is installed.

Next:
  1. Edit $ROOT/inventory.json so lanes point at machines you own, then:
       npm run inventory:sync
  2. Enable a self-hosted runtime (example):
       npm run inventory:enable -- example-gpu-box.sglang
  3. Check routing:
       $PYTHON_BIN $ROOT/hermes-orchestration/scripts/hermes_orchestrator.py health
  4. Chat with Hermes through the local-first GPU/Ollama proxy:
       xx-hermes
  5. Or chat through the :8082 loopback catalog (after install-opencode):
       foc-hermes

xx-hermes is the :8180 self-hosted plane (sglang → ollama, cloud opt-in).
foc-hermes is the :8082 catalog plane (codex_responses, same models as foc-opencode).

Token file: $TOKEN_FILE
EOF
