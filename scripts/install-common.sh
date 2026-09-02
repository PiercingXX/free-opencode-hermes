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

merge_json_plugin() {
  local config_path="$1"
  local plugin_ref="$2"
  node --input-type=module - "$config_path" "$plugin_ref" <<'NODE'
import fs from "node:fs";
import path from "node:path";

const [configPath, pluginRef] = process.argv.slice(2);
fs.mkdirSync(path.dirname(configPath), { recursive: true });
let config = {};
if (fs.existsSync(configPath)) {
  const raw = fs.readFileSync(configPath, "utf8").trim();
  if (raw) config = JSON.parse(raw);
}
if (typeof config !== "object" || config === null || Array.isArray(config)) {
  config = {};
}
const plugins = Array.isArray(config.plugin) ? config.plugin : [];
const already = plugins.some((entry) => {
  if (typeof entry === "string") return entry === pluginRef || entry.startsWith("free-opencode");
  return false;
});
if (!already) plugins.push(pluginRef);
config.plugin = plugins;
if (!config.$schema) config.$schema = "https://opencode.ai/config.json";
const tmp = `${configPath}.tmp-${process.pid}`;
fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
fs.renameSync(tmp, configPath);
console.log(`registered plugin in ${configPath}`);
NODE
}
