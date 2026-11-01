# Shared helpers for install-opencode.sh and install-hermes.sh.
# shellcheck shell=bash

info() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

need() {
  have "$1" || die "missing required command: $1"
}

repo_root() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd -P)"
  if [ -d "$here/xx-stack" ]; then
    printf '%s\n' "$here"
    return
  fi
  here="$(cd "$(dirname "${BASH_SOURCE[1]}")/.." && pwd -P)"
  [ -d "$here/xx-stack" ] || die "could not find repo root (no xx-stack/ next to the installer)"
  printf '%s\n' "$here"
}

require_node() {
  need node
  need npm
  local major
  major="$(node -p "process.versions.node.split('.')[0]")"
  if [ "$major" -lt 20 ]; then
    die "Node.js 20+ is required (found $(node -v))"
  fi
}

ensure_local_bin() {
  mkdir -p "$HOME/.local/bin"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *)
      warn "add $HOME/.local/bin to PATH (echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc)"
      ;;
  esac
}

link_cmd() {
  local src="$1"
  local name="$2"
  ensure_local_bin
  ln -sfn "$src" "$HOME/.local/bin/$name"
  chmod +x "$src" 2>/dev/null || true
  info "linked $HOME/.local/bin/$name"
}

seed_inventory() {
  local root="$1"
  if [ ! -f "$root/inventory.json" ]; then
    cp "$root/inventory.example.json" "$root/inventory.json"
    info "created inventory.json from the example template (edit it to match your machines)"
  fi
}

npm_bootstrap() {
  local root="$1"
  info "installing npm workspaces"
  if [ -f "$root/package-lock.json" ]; then
    (cd "$root" && npm ci)
  else
    (cd "$root" && npm install)
  fi
  info "building xx-stack MCP server"
  npm --prefix "$root/xx-stack/mcp-server" run build
  info "building Free OpenCode plugin"
  npm run build -w free-opencode
}

sync_inventory() {
  local root="$1"
  info "syncing inventory -> platform registries and Hermes lanes"
  node "$root/xx-stack/scripts/generate-registries.mjs"
}

# Download a vendor install script to a temp file, sanity-check it, then run it.
# Never pipes the network straight into a shell: a truncated or HTML error
# response is rejected instead of half-executed. No checksum pin (vendor
# scripts change); set the named skip variable to 1 to skip entirely.
#   run_vendor_installer <url> <display-name> <SKIP_ENV_VAR_NAME>
run_vendor_installer() {
  local url="$1"
  local name="$2"
  local skip_var="$3"
  if [ "${!skip_var:-0}" = "1" ]; then
    info "$skip_var=1 — skipping the $name installer"
    return 0
  fi
  need curl
  local tmp problem="" rc=0
  tmp="$(mktemp "${TMPDIR:-/tmp}/foc-vendor-install.XXXXXX")" || die "mktemp failed"
  info "downloading the $name installer from $url"
  if ! curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp" "$url"; then
    problem="could not download the $name installer ($url)"
  elif [ ! -s "$tmp" ]; then
    problem="the $name installer download was empty ($url)"
  elif ! head -n 1 "$tmp" | grep -Eq '^#!.*(ba|z|da|k)?sh'; then
    problem="the $name installer ($url) does not look like a shell script; refusing to run it"
  fi
  if [ -n "$problem" ]; then
    rm -f "$tmp"
    die "$problem. Install $name yourself, or set $skip_var=1 to skip this step."
  fi
  info "running the $name installer ($(wc -c <"$tmp" | tr -d ' ') bytes)"
  bash "$tmp" || rc=$?
  rm -f "$tmp"
  return "$rc"
}
