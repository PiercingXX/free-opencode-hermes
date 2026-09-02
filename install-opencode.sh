#!/usr/bin/env bash
# Install OpenCode, the Free OpenCode plugin, and the full xx-stack runtime.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/install-common.sh
. "$SCRIPT_DIR/scripts/install-common.sh"

ROOT="$(repo_root)"
SKIP_OPENCODE_BIN=0
FORCE_SETUP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-opencode) SKIP_OPENCODE_BIN=1; shift ;;
    --force) FORCE_SETUP=1; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: ./install-opencode.sh [--skip-opencode] [--force]

Installs OpenCode, the Free OpenCode plugin/proxy, and the xx-stack
agents, skills, MCP server, and inventory.

  --skip-opencode   Do not download the OpenCode CLI (use an existing install)
  --force           Pass --force through to xx-stack OpenCode setup
EOF
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_node
seed_inventory "$ROOT"
npm_bootstrap "$ROOT"
sync_inventory "$ROOT"

if [ "$SKIP_OPENCODE_BIN" -eq 0 ]; then
  if have opencode; then
    info "OpenCode already on PATH: $(command -v opencode)"
  else
    info "installing OpenCode CLI"
    curl -fsSL https://opencode.ai/install | bash
    hash -r || true
    have opencode || warn "OpenCode installer finished but 'opencode' is not on PATH yet — open a new shell"
  fi
fi

info "wiring OpenCode plugin, skills, MCP, CLI, and proxy"
# Do not run opencode-orchestration/setup.sh here. That script expects a
# copied stack at ~/.config/opencode/skills/xx-stack (mcp-server, .opencode/skills)
# and hard-exits when it is missing. The plugin + host-setup.mjs is the install
# path: it copies skills/agents, registers the plugin and MCP against this repo,
# and starts the proxy.
SETUP_ARGS=()
if [ "$FORCE_SETUP" -eq 1 ]; then
  warn "--force is accepted for compatibility; host-setup overwrites generated wrappers and skill copies"
fi
node "$ROOT/scripts/host-setup.mjs" opencode-host

cat <<EOF

Free OpenCode is installed.

Next:
  1. Open Admin and paste at least one provider key:
       $($HOME/.local/bin/free-opencode admin 2>/dev/null || echo "http://127.0.0.1:8082/admin")
     or:  free-opencode connect nvidia_nim
  2. Pick a default model:
       free-opencode set-model nvidia_nim/nvidia/nemotron-3-super-120b-a12b
       free-opencode set-fallback open_router/openrouter/free groq/llama-3.3-70b-versatile
  3. Run OpenCode against the local catalog (OpenCode 1.18.18+):
       foc-opencode
     or:  free-opencode opencode

foc-opencode writes a process-local config (Responses API, overlay-forced
model) and does not rewrite your saved OpenCode settings. Bare `opencode`
still works via the plugin.

Also installed: foc-hermes (same :8082 catalog, Hermes Agent 0.20.4+).

Your machine inventory lives at $ROOT/inventory.json
EOF
