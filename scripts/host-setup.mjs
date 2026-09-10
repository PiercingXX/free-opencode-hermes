#!/usr/bin/env node
/**
 * Cross-platform host wiring used by install-opencode and install-hermes.
 * Safe on Linux and Windows: file:// plugin URLs, CLI wrappers, skill copies.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const home = os.homedir();
const isWin = process.platform === "win32";

function info(message) {
  console.log(`==> ${message}`);
}

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? path.join(xdg, "opencode") : path.join(home, ".config", "opencode");
}

function binDir() {
  return path.join(home, ".local", "bin");
}

function writeAtomic(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contents, { encoding: "utf8" });
  fs.renameSync(tmp, filePath);
}

/**
 * Merge src onto dest. Shared by install-opencode.sh and install-opencode.ps1.
 * Node 26's fs.cpSync C++ path throws EEXIST when dest already exists and
 * contains a dangling symlink or junction (a leftover `skills/design`
 * pointing at a previous clone is the usual case).
 */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    copyPath(path.join(src, name), path.join(dest, name));
  }
}

function copyPath(src, dest) {
  const srcStat = fs.lstatSync(src);
  if (srcStat.isSymbolicLink()) {
    copySymlink(src, dest);
    return;
  }
  const placeholder = gitLinkPlaceholderTarget(src, srcStat);
  if (placeholder) {
    copyResolved(placeholder, dest);
    return;
  }
  if (srcStat.isDirectory()) {
    let destStat = null;
    try {
      destStat = fs.lstatSync(dest);
    } catch {
      destStat = null;
    }
    if (destStat && (destStat.isSymbolicLink() || !destStat.isDirectory())) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    copyDir(src, dest);
    return;
  }
  try {
    const destStat = fs.lstatSync(dest);
    if (destStat.isDirectory() || destStat.isSymbolicLink()) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  } catch {
    // dest is missing
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** Git without core.symlinks writes the link text as a file (common on Windows). */
function gitLinkPlaceholderTarget(src, srcStat) {
  if (!srcStat.isFile() || srcStat.size === 0 || srcStat.size > 512) return null;
  let text;
  try {
    text = fs.readFileSync(src, "utf8");
  } catch {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed || /[\n\r\0]/.test(trimmed)) return null;
  if (!trimmed.includes("/") && !trimmed.includes("\\")) return null;
  const resolved = path.resolve(path.dirname(src), trimmed);
  try {
    const st = fs.statSync(resolved);
    if (st.isDirectory() || st.isFile()) return resolved;
  } catch {
    return null;
  }
  return null;
}

function copyResolved(target, dest) {
  const st = fs.statSync(target);
  if (st.isDirectory()) {
    fs.rmSync(dest, { recursive: true, force: true });
    copyDir(target, dest);
    return;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(target, dest);
}

function copySymlink(src, dest) {
  const raw = fs.readlinkSync(src);
  const target = path.resolve(path.dirname(src), raw);
  fs.rmSync(dest, { recursive: true, force: true });
  let srcIsDir = false;
  try {
    srcIsDir = fs.statSync(src).isDirectory();
  } catch {
    // dangling source link
  }
  if (isWin) {
    const type = srcIsDir ? "junction" : "file";
    try {
      fs.symlinkSync(target, dest, type);
      return;
    } catch {
      if (srcIsDir) {
        copyDir(target, dest);
        return;
      }
      try {
        fs.copyFileSync(target, dest);
      } catch {
        // dangling file link
      }
      return;
    }
  }
  fs.symlinkSync(target, dest);
}

/** OpenCode ships build/plan/general. Copying xx-stack markdown over those names empties tool calls. */
const OPENCODE_NATIVE_AGENT_FILES = new Set(["build.md", "plan.md", "general.md"]);

function copyAgentsSkippingNativePrimaries(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of OPENCODE_NATIVE_AGENT_FILES) {
    try {
      fs.unlinkSync(path.join(dest, name));
    } catch {
      // missing
    }
  }
  for (const name of fs.readdirSync(src)) {
    if (OPENCODE_NATIVE_AGENT_FILES.has(name)) continue;
    copyPath(path.join(src, name), path.join(dest, name));
  }
}

function quoteForCmd(value) {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function quoteForSh(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function writeUnixWrapper(dest, execPath, scriptPath, extraArgs = []) {
  const extras = extraArgs.map(quoteForSh).join(" ");
  const cmd = extras
    ? `${quoteForSh(execPath)} ${quoteForSh(scriptPath)} ${extras}`
    : `${quoteForSh(execPath)} ${quoteForSh(scriptPath)}`;
  const body = `#!/bin/sh\nexec ${cmd} "$@"\n`;
  writeAtomic(dest, body);
  try {
    fs.chmodSync(dest, 0o755);
  } catch {
    // Windows ignores chmod
  }
}

function writeWindowsWrapper(dest, execPath, scriptPath, extraArgs = []) {
  const extras = extraArgs.map(quoteForCmd).join(" ");
  const cmd = extras
    ? `${quoteForCmd(execPath)} ${quoteForCmd(scriptPath)} ${extras}`
    : `${quoteForCmd(execPath)} ${quoteForCmd(scriptPath)}`;
  const body = `@echo off\r\n${cmd} %*\r\n`;
  writeAtomic(dest, body);
}

function installWrapper(name, execPath, scriptPath, extraArgs = []) {
  fs.mkdirSync(binDir(), { recursive: true });
  const unixPath = path.join(binDir(), name);
  writeUnixWrapper(unixPath, execPath, scriptPath, extraArgs);
  if (isWin) {
    writeWindowsWrapper(path.join(binDir(), `${name}.cmd`), execPath, scriptPath, extraArgs);
  }
  info(`installed ${name} -> ${scriptPath}${extraArgs.length ? " " + extraArgs.join(" ") : ""}`);
}

function loadJsonObject(configPath) {
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, "utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed;
}

function mergePlugin(configPath, pluginRef, mcpEntrypoint) {
  const config = loadJsonObject(configPath);
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  const already = plugins.some(
    (entry) =>
      typeof entry === "string" &&
      (entry === pluginRef || entry.includes("packages/plugin/src/index.ts"))
  );
  if (!already) plugins.push(pluginRef);
  config.plugin = plugins;
  config.enabled_providers = ["free-opencode"];
  if (!config.model) config.model = "free-opencode/default";
  if (!config.small_model) config.small_model = "free-opencode/default";
  const disabled = Array.isArray(config.disabled_providers) ? config.disabled_providers : [];
  config.disabled_providers = Array.from(
    new Set(disabled.filter((id) => id !== "free-opencode").concat(["opencode"]))
  );
  if (!config.$schema) config.$schema = "https://opencode.ai/config.json";
  if (mcpEntrypoint && fs.existsSync(mcpEntrypoint)) {
    config.mcp = config.mcp && typeof config.mcp === "object" ? config.mcp : {};
    config.mcp["xx-stack-platform-routing"] = {
      type: "local",
      enabled: true,
      command: [process.execPath, mcpEntrypoint],
      environment: {
        XX_STACK_REPO: path.join(repoRoot, "xx-stack"),
        FREE_OPENCODE_REPO: repoRoot,
      },
    };
    info("registered MCP xx-stack-platform-routing");
  }
  writeAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
  info(`registered plugin in ${configPath}`);
}

function opencodeHost() {
  const pluginEntry = path.join(repoRoot, "packages", "plugin", "src", "index.ts");
  if (!fs.existsSync(pluginEntry)) die(`plugin entry missing: ${pluginEntry}`);
  const cli = path.join(repoRoot, "packages", "plugin", "dist", "cli.js");
  if (!fs.existsSync(cli)) die(`plugin CLI was not built: ${cli}`);

  const ocDir = configDir();
  fs.mkdirSync(ocDir, { recursive: true });
  const mcpEntrypoint = path.join(repoRoot, "xx-stack", "mcp-server", "dist", "index.js");
  mergePlugin(path.join(ocDir, "opencode.json"), pathToFileURL(pluginEntry).href, mcpEntrypoint);

  const skillsSrc = path.join(repoRoot, "xx-stack", "runtime", "skills");
  if (fs.existsSync(skillsSrc)) {
    copyDir(skillsSrc, path.join(ocDir, "skills"));
    info(`copied skills to ${path.join(ocDir, "skills")}`);
  }
  const agentsSrc = path.join(repoRoot, "xx-stack", "runtime", "agents");
  if (fs.existsSync(agentsSrc)) {
    copyAgentsSkippingNativePrimaries(agentsSrc, path.join(ocDir, "agents"));
    info(
      `copied agents to ${path.join(ocDir, "agents")} (skipped OpenCode native build/plan/general)`
    );
  }
  const commandSrc = path.join(repoRoot, "opencode-orchestration", "opencode", "command");
  if (fs.existsSync(commandSrc)) {
    copyDir(commandSrc, path.join(ocDir, "command"));
    info(`copied slash commands to ${path.join(ocDir, "command")}`);
  }
  const platformsSrc = path.join(repoRoot, "xx-stack", "runtime", "platforms.json");
  if (fs.existsSync(platformsSrc)) {
    fs.copyFileSync(platformsSrc, path.join(ocDir, "xx-stack-platforms.json"));
    info("seeded xx-stack-platforms.json");
  }

  installWrapper("free-opencode", process.execPath, cli);
  installWrapper("foc-opencode", process.execPath, cli, ["opencode"]);
  installWrapper("foc-hermes", process.execPath, cli, ["hermes"]);
  startProxy(cli);
}

function startProxy(cli) {
  spawnSync(process.execPath, [cli, "stop"], {
    stdio: "inherit",
    windowsHide: true,
    env: process.env,
  });
  const result = spawnSync(process.execPath, [cli, "start"], {
    stdio: "inherit",
    windowsHide: true,
    env: process.env,
  });
  if (result.status !== 0) die("failed to start the Free OpenCode proxy");
}

function resolvePython() {
  const names = isWin ? ["python", "python3", "py"] : ["python3", "python"];
  for (const name of names) {
    const args =
      name === "py"
        ? ["-3", "-c", "import sys; print(sys.executable)"]
        : ["-c", "import sys; print(sys.executable)"];
    const result = spawnSync(name, args, { encoding: "utf8", windowsHide: true });
    const exe = result.stdout?.trim();
    if (result.status === 0 && exe) return exe;
  }
  die("Python 3 is required (python3 or python on PATH)");
}

function hermesHost() {
  const hermesDir = path.join(repoRoot, "hermes-orchestration");
  const launcher = path.join(hermesDir, "scripts", "xx_hermes.py");
  if (!fs.existsSync(launcher)) die(`missing ${launcher}`);
  fs.mkdirSync(path.join(hermesDir, "logs"), { recursive: true });

  const tokenDir = path.join(home, ".config", "hermes-orchestration");
  fs.mkdirSync(tokenDir, { recursive: true });
  const tokenFile = path.join(tokenDir, "proxy.env");
  if (!fs.existsSync(tokenFile)) {
    writeAtomic(tokenFile, `HERMES_PROXY_TOKEN=${randomBytes(24).toString("hex")}\n`);
    try {
      fs.chmodSync(tokenFile, 0o600);
    } catch {
      // Windows
    }
    info(`wrote ${tokenFile}`);
  } else {
    info(`keeping existing ${tokenFile}`);
  }

  const python = process.env.PYTHON?.trim() || resolvePython();
  installWrapper("xx-hermes", python, launcher);
  const cli = path.join(repoRoot, "packages", "plugin", "dist", "cli.js");
  if (fs.existsSync(cli)) {
    installWrapper("foc-hermes", process.execPath, cli, ["hermes"]);
  } else {
    info("plugin CLI not built; skip foc-hermes (run install-opencode or npm run plugin:build)");
  }
}

export { copyDir, copyAgentsSkippingNativePrimaries };

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const cmd = process.argv[2];
  if (cmd === "opencode-host") {
    opencodeHost();
  } else if (cmd === "hermes-host") {
    hermesHost();
  } else {
    console.log("Usage: node scripts/host-setup.mjs opencode-host|hermes-host");
    process.exit(1);
  }
}
