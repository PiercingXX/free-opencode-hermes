# Install Hermes Agent plus this repo's hermes-orchestration control plane (Windows).
param(
    [switch] $SkipHermes,
    [switch] $Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Info([string] $Message) { Write-Host "==> $Message" }
function Die([string] $Message) { Write-Error $Message; exit 1 }

if ($Help) {
    @"
Usage: .\install-hermes.ps1 [-SkipHermes]

Installs Hermes Agent, generates lanes from inventory.json, writes the
loopback orchestration token, and puts xx-hermes on PATH.

  -SkipHermes   Do not download Hermes Agent
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

$python = Get-Application "python"
if (-not $python) { $python = Get-Application "python3" }
if (-not $python) { $python = Get-Application "py" }
if (-not $python) {
    Die "Python 3 is required. Install from https://www.python.org then re-run."
}

$inventory = Join-Path $Root "inventory.json"
if (-not (Test-Path -LiteralPath $inventory)) {
    Copy-Item (Join-Path $Root "inventory.example.json") $inventory
    Write-Info "created inventory.json from the example template"
}

Write-Info "installing npm workspaces and generating Hermes lanes"
Push-Location $Root
try {
    if (Test-Path -LiteralPath (Join-Path $Root "package-lock.json")) {
        & $npm.Source "ci"
    } else {
        & $npm.Source "install"
    }
    if ($LASTEXITCODE -ne 0) { Die "npm install failed" }
    & $npm.Source "--prefix" (Join-Path $Root "xx-stack\mcp-server") "run" "build"
    if ($LASTEXITCODE -ne 0) { Die "mcp-server build failed" }
    & $npm.Source "run" "build" "-w" "free-opencode"
    if ($LASTEXITCODE -ne 0) { Die "plugin build failed" }
    & $node.Source (Join-Path $Root "xx-stack\scripts\generate-registries.mjs")
    if ($LASTEXITCODE -ne 0) { Die "inventory sync failed" }
} finally {
    Pop-Location
}

if (-not $SkipHermes) {
    $existing = Get-Application "hermes"
    if ($existing) {
        Write-Info "Hermes Agent already on PATH: $($existing.Source)"
    } else {
        Write-Info "installing Hermes Agent"
        $installer = Join-Path ([IO.Path]::GetTempPath()) ("foc-hermes-" + [guid]::NewGuid().ToString("N") + ".ps1")
        try {
            Invoke-RestMethod -Uri "https://hermes-agent.nousresearch.com/install.ps1" -OutFile $installer
            $pwsh = if ($PSVersionTable.PSEdition -eq "Core") { "pwsh" } else { "powershell" }
            & $pwsh -NoProfile -ExecutionPolicy Bypass -File $installer -NonInteractive -SkipSetup
            if ($LASTEXITCODE -ne 0) { Die "Hermes installer failed" }
            Add-UserPath (Join-Path $env:LOCALAPPDATA "hermes\hermes-agent\bin")
        } finally {
            Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-Info "wiring Hermes host files and xx-hermes launcher"
& $node.Source (Join-Path $Root "scripts\host-setup.mjs") "hermes-host"
if ($LASTEXITCODE -ne 0) { Die "host setup failed" }

Add-UserPath (Join-Path $env:USERPROFILE ".local\bin")

Write-Info "running Hermes orchestrator unit tests"
Push-Location (Join-Path $Root "hermes-orchestration")
try {
    $pyArgs = @("-m", "unittest", "discover", "-s", "tests")
    if ($python.Name -eq "py.exe" -or $python.Name -eq "py") {
        & $python.Source "-3" @pyArgs
    } else {
        & $python.Source @pyArgs
    }
    if ($LASTEXITCODE -ne 0) { Die "Hermes unit tests failed" }
} finally {
    Pop-Location
}

$tokenFile = Join-Path $env:USERPROFILE ".config\hermes-orchestration\proxy.env"
Write-Host ""
Write-Host "Hermes setup is installed."
Write-Host ""
Write-Host "Next:"
Write-Host "  1. Edit $Root\inventory.json so lanes point at machines you own, then:"
Write-Host "       npm run inventory:sync"
Write-Host "  2. Chat with Hermes through the local-first GPU/Ollama proxy:"
Write-Host "       xx-hermes"
Write-Host "  3. Or the :8082 loopback catalog (after install-opencode):"
Write-Host "       foc-hermes"
Write-Host ""
Write-Host "xx-hermes is :8180 (started on demand). foc-hermes is the :8082 catalog."
Write-Host "Token file: $tokenFile"
Write-Host "If 'xx-hermes' is not found, open a new terminal so PATH updates apply."
