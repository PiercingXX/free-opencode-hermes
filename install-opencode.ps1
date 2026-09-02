# Install OpenCode, the Free OpenCode plugin, and the full xx-stack runtime (Windows).
param(
    [switch] $SkipOpenCode,
    [switch] $Force,
    [switch] $Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Info([string] $Message) { Write-Host "==> $Message" }
function Die([string] $Message) { Write-Error $Message; exit 1 }

if ($Help) {
    @"
Usage: .\install-opencode.ps1 [-SkipOpenCode] [-Force]

Installs OpenCode, the Free OpenCode plugin/proxy, and the xx-stack
agents, skills, MCP server, and inventory.

  -SkipOpenCode   Do not download the OpenCode CLI
  -Force          Overwrite existing host files
"@
    exit 0
}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path -LiteralPath (Join-Path $Root "xx-stack"))) {
    Die "could not find repo root (no xx-stack\ next to the installer)"
}

function Get-Application([string] $Name) {
    return Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue
}

function Add-UserPath([string] $Entry) {
    if ([string]::IsNullOrWhiteSpace($Entry)) { return }
    $current = [Environment]::GetEnvironmentVariable("Path", "User")
    if ([string]::IsNullOrEmpty($current)) { $current = "" }
    $parts = $current -split ";"
    if ($parts -contains $Entry) {
        $env:Path = "$Entry;$env:Path"
        return
    }
    [Environment]::SetEnvironmentVariable("Path", "$Entry;$current", "User")
    $env:Path = "$Entry;$env:Path"
    Write-Info "added $Entry to your user PATH (open a new terminal if commands are missing)"
}

$node = Get-Application "node"
$npm = Get-Application "npm"
if (-not $node -or -not $npm) {
    Die "Node.js 20+ and npm are required. Install from https://nodejs.org then re-run."
}
$major = & $node.Source -p "process.versions.node.split('.')[0]"
if ([int]$major -lt 20) {
    Die "Node.js 20+ is required (found $(& $node.Source -v))"
}

$inventory = Join-Path $Root "inventory.json"
if (-not (Test-Path -LiteralPath $inventory)) {
    Copy-Item (Join-Path $Root "inventory.example.json") $inventory
    Write-Info "created inventory.json from the example template"
}

Write-Info "installing npm workspaces"
Push-Location $Root
try {
    if (Test-Path -LiteralPath (Join-Path $Root "package-lock.json")) {
        & $npm.Source "ci"
    } else {
        & $npm.Source "install"
    }
    if ($LASTEXITCODE -ne 0) { Die "npm install failed" }
    Write-Info "building xx-stack MCP server"
    & $npm.Source "--prefix" (Join-Path $Root "xx-stack\mcp-server") "run" "build"
    if ($LASTEXITCODE -ne 0) { Die "mcp-server build failed" }
    Write-Info "building Free OpenCode plugin"
    & $npm.Source "run" "build" "-w" "free-opencode"
    if ($LASTEXITCODE -ne 0) { Die "plugin build failed" }
    Write-Info "syncing inventory"
    & $node.Source (Join-Path $Root "xx-stack\scripts\generate-registries.mjs")
    if ($LASTEXITCODE -ne 0) { Die "inventory sync failed" }
} finally {
    Pop-Location
}

if (-not $SkipOpenCode) {
    $existing = Get-Application "opencode"
    if ($existing) {
        Write-Info "OpenCode already on PATH: $($existing.Source)"
    } else {
        Write-Info "installing OpenCode CLI"
        $arch = $env:PROCESSOR_ARCHITEW6432
        if ([string]::IsNullOrWhiteSpace($arch)) { $arch = $env:PROCESSOR_ARCHITECTURE }
        $asset = switch ($arch.ToUpperInvariant()) {
            "ARM64" { "opencode-windows-arm64.zip" }
            default { "opencode-windows-x64-baseline.zip" }
        }
        $url = "https://github.com/anomalyco/opencode/releases/latest/download/$asset"
        $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("foc-opencode-" + [guid]::NewGuid().ToString("N"))
        $zipPath = Join-Path $tempRoot $asset
        $extract = Join-Path $tempRoot "extracted"
        $installDir = Join-Path $env:USERPROFILE ".opencode\bin"
        try {
            New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
            Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
            Expand-Archive -LiteralPath $zipPath -DestinationPath $extract
            $exe = Get-ChildItem -LiteralPath $extract -Recurse -File -Filter "opencode.exe" | Select-Object -First 1
            if (-not $exe) { Die "OpenCode archive did not contain opencode.exe" }
            New-Item -ItemType Directory -Force -Path $installDir | Out-Null
            Copy-Item -LiteralPath $exe.FullName -Destination (Join-Path $installDir "opencode.exe") -Force
            Add-UserPath $installDir
        } finally {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-Info "wiring OpenCode host files, plugin, and CLI"
& $node.Source (Join-Path $Root "scripts\host-setup.mjs") "opencode-host"
if ($LASTEXITCODE -ne 0) { Die "host setup failed" }

Add-UserPath (Join-Path $env:USERPROFILE ".local\bin")

Write-Host ""
Write-Host "Free OpenCode is installed."
Write-Host ""
Write-Host "Next:"
Write-Host "  1. Open Admin and paste at least one provider key:"
Write-Host "       http://127.0.0.1:8082/admin"
Write-Host "     or:  free-opencode connect nvidia_nim"
Write-Host "  2. Pick a default model:"
Write-Host "       free-opencode set-model nvidia_nim/nvidia/nemotron-3-super-120b-a12b"
Write-Host "  3. Run OpenCode against the local catalog (OpenCode 1.18.18+):"
Write-Host "       foc-opencode"
Write-Host "     or:  free-opencode opencode"
Write-Host ""
Write-Host "foc-opencode writes a process-local config and does not rewrite your saved OpenCode settings."
Write-Host "Also installed: foc-hermes (same catalog; Hermes Agent 0.20.4+)."
Write-Host ""
Write-Host "If 'free-opencode' is not found, open a new terminal so PATH updates apply."
