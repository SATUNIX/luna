<#
.SYNOPSIS
  General install/setup/config/update helper for pi-system.
.DESCRIPTION
  Run with no -Command for an interactive menu. See helpers/README.md.
.PARAMETER Command
  status | install | configure | update-kit | update-pi | help
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet("status", "install", "configure", "update-kit", "update-pi", "help")]
  [string]$Command
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Profiles = @("quick", "balanced", "long-horizon", "autonomous", "pentest", "self-improving", "lite")
$AgentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME ".pi\agent" }

function Write-Heading($text) { Write-Host $text -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host $text -ForegroundColor Green }
function Write-Err($text) { Write-Host $text -ForegroundColor Red }

function Test-Command($name) {
  $null = Get-Command $name -ErrorAction SilentlyContinue
  return $?
}

function Test-Prereqs {
  Write-Heading "Checking prerequisites"
  $ok = $true
  if (Test-Command node) { Write-Host "  node:  $(node --version)" } else { Write-Err "  node:  not found"; $ok = $false }
  if (Test-Command git) { Write-Host "  git:   $(git --version)" } else { Write-Err "  git:   not found"; $ok = $false }
  if (Test-Command pi) {
    $v = (pi --version 2>$null)
    Write-Host "  pi:    $v"
  } else {
    Write-Host "  pi:    not installed (see 'update-pi' or 'install')"
  }
  return $ok
}

function Invoke-Status {
  Test-Prereqs | Out-Null
  Write-Host ""
  Write-Heading "Repo state"
  Write-Host "  path:   $Root"
  $branch = git rev-parse --abbrev-ref HEAD 2>$null
  Write-Host "  branch: $branch"
  $dirty = (git status --porcelain 2>$null | Measure-Object -Line).Lines
  Write-Host "  dirty files: $dirty"
  Write-Host ""
  Write-Heading "pi global settings"
  Write-Host "  agent dir: $AgentDir"
  $settingsPath = Join-Path $AgentDir "settings.json"
  if (Test-Path $settingsPath) {
    Write-Host "  settings:  $settingsPath (exists)"
  } else {
    Write-Host "  settings:  not found - pi has not been installed/registered yet"
  }
}

function Confirm-Action($prompt) {
  $reply = Read-Host "$prompt [y/N]"
  return $reply -match "^[Yy]$"
}

function Select-Profile {
  Write-Heading "Profiles"
  for ($i = 0; $i -lt $Profiles.Count; $i++) {
    Write-Host "  $($i + 1)) $($Profiles[$i])"
  }
  $choice = Read-Host "Choose a profile [1-$($Profiles.Count), default 2=balanced]"
  if ([string]::IsNullOrWhiteSpace($choice)) { $choice = "2" }
  $idx = 0
  if (-not [int]::TryParse($choice, [ref]$idx) -or $idx -lt 1 -or $idx -gt $Profiles.Count) {
    return "balanced"
  }
  return $Profiles[$idx - 1]
}

function Invoke-Install {
  if (-not (Test-Prereqs)) { Write-Err "Fix the missing prerequisites above, then re-run."; return }
  Write-Host ""
  Write-Host "Installs this checkout in place (editable). Pick 'lite' for small local models."
  $profile = Select-Profile
  $scopeChoice = Read-Host "Scope: (g)lobal or (p)roject? [g]"
  if ([string]::IsNullOrWhiteSpace($scopeChoice)) { $scopeChoice = "g" }
  $scope = if ($scopeChoice -eq "p") { "project" } else { "global" }
  Write-Host "Running: node $Root/install.ts --profile $profile --scope $scope --dry-run"
  node "$Root/install.ts" --profile $profile --scope $scope --dry-run
  if (Confirm-Action "Apply this install for real?") {
    node "$Root/install.ts" --profile $profile --scope $scope --yes
    Write-Ok "Installed. Run 'pi' then '/reload' if pi was already running, or 'pi list' to confirm."
  } else {
    Write-Host "Dry run only - nothing changed."
  }
}

function Invoke-UpdatePi {
  Write-Heading "Updating pi core (@earendil-works/pi-coding-agent)"
  # The version the kit is tested against (its exact devDependencies pin), never "latest", and
  # without install scripts.
  $kitPackage = Join-Path (Split-Path -Parent (Split-Path -Parent $Root)) "package.json"
  $version = (Get-Content -Raw $kitPackage | ConvertFrom-Json).devDependencies.'@earendil-works/pi-coding-agent'
  if (-not ($version -match '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$')) {
    Write-Err "Could not read an exact pi version from the kit's package.json (got '$version'); not installing."
    return
  }
  Write-Host "Running: npm install -g --ignore-scripts @earendil-works/pi-coding-agent@$version"
  npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@$version"
  pi --version
}

function Invoke-UpdateKit {
  Write-Heading "Updating the kit"
  $dirty = (git status --porcelain | Measure-Object -Line).Lines
  if ($dirty -gt 0) {
    Write-Err "Working tree has $dirty uncommitted change(s). Commit or stash before updating."
    git status --short
    return
  }
  git pull
  $profile = Select-Profile
  Write-Host "Running: node $Root/install.ts --profile $profile --yes"
  node "$Root/install.ts" --profile $profile --yes
  Write-Ok "Kit updated. Run '/reload' inside pi, or restart pi, then 'pi list' to confirm."
}

function Invoke-Configure {
  Write-Heading "Configuring pi-kit environment"
  New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
  $envFile = Join-Path $AgentDir ".env"
  if (Test-Path $envFile) {
    Write-Host "  $envFile already exists - leaving it as is."
  } else {
    Copy-Item (Join-Path $Root ".env.example") $envFile
    Write-Ok "  Created $envFile from .env.example."
  }
  Write-Host "  Edit $envFile directly to set MEM0_API_KEY, DUAL_REVIEW_MODEL, PI_KIT_MEMORY_BACKEND, etc."
  Write-Host "  Full variable reference: docs/INSTALL.md (Environment variables section)."
  if (Confirm-Action "Set a firewall policy override (PI_KIT_FIREWALL_POLICY) now?") {
    $policyPath = Read-Host "  Path to custom policy JSON"
    if (-not [string]::IsNullOrWhiteSpace($policyPath)) {
      Add-Content -Path $envFile -Value "PI_KIT_FIREWALL_POLICY=$policyPath"
      Write-Ok "  Appended PI_KIT_FIREWALL_POLICY to $envFile."
    }
  }
}

function Show-Usage {
  @"
pi-kit-helper.ps1 - install, setup, configure, and update pi-system

Usage:
  helpers\pi-kit-helper.ps1 [-Command <name>]

Commands:
  status        Show prerequisite versions, repo state, and current pi registration
  install       Install this checkout with a profile (lite for small local models), interactively
  configure     Scaffold ~/.pi/agent/.env and set common environment variables
  update-kit    git pull + reinstall with a profile
  update-pi     Update the pi core binary (@earendil-works/pi-coding-agent)
  help          Show this message

With no -Command, shows an interactive menu.
"@
}

function Show-Menu {
  Write-Heading "pi-system helper"
  Write-Host "1) status"
  Write-Host "2) install"
  Write-Host "3) configure"
  Write-Host "4) update-kit"
  Write-Host "5) update-pi"
  Write-Host "6) help"
  Write-Host "0) exit"
  $choice = Read-Host "Choose"
  switch ($choice) {
    "1" { Invoke-Status }
    "2" { Invoke-Install }
    "3" { Invoke-Configure }
    "4" { Invoke-UpdateKit }
    "5" { Invoke-UpdatePi }
    "6" { Show-Usage }
    "0" { return }
    default { Write-Err "Unknown choice." }
  }
}

switch ($Command) {
  "status" { Invoke-Status }
  "install" { Invoke-Install }
  "configure" { Invoke-Configure }
  "update-kit" { Invoke-UpdateKit }
  "update-pi" { Invoke-UpdatePi }
  "help" { Show-Usage }
  default { Show-Menu }
}
