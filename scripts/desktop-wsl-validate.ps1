#requires -Version 7.0
# Run only in the explicitly provisioned disposable Windows/WSL validation VM.
# This starts the named distro and real desktop, but installs/removes nothing.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^(Ubuntu(-[0-9.]+)?|Debian)$')][string]$Distribution,
  [Parameter(Mandatory)][ValidatePattern('^/home/[^/]+/.+')][string]$ProfileHome,
  [string]$EvidenceDirectory = (Join-Path $PSScriptRoot '../test-results/wsl-manual')
)
$ErrorActionPreference = 'Stop'
if ($ProfileHome -match '[\x00-\x1f\x7f\\]' -or $ProfileHome.Split('/') -contains '..') { throw 'Use a fresh absolute Linux home path without traversal.' }
$repoRoot = Split-Path $PSScriptRoot -Parent
$wslExe = Join-Path $env:SystemRoot 'System32/wsl.exe'
$inventory = (& $wslExe --list --verbose | Out-String).Replace([string][char]0,'')
if ($LASTEXITCODE -ne 0 -or $inventory -notmatch ('(?m)^\s*\*?\s*' + [regex]::Escape($Distribution) + '\s+.+\s+2\s*$')) { throw 'The exact supported WSL2 distribution is not available.' }
$uidText = & $wslExe --distribution $Distribution --exec /usr/bin/id -u
if ($LASTEXITCODE -ne 0 -or "$uidText" -notmatch '^\d+$' -or [int]$uidText -eq 0) { throw 'The selected distro must run as a non-root user.' }
& $wslExe --distribution $Distribution --exec /usr/bin/test -e $ProfileHome
if ($LASTEXITCODE -ne 1) { throw 'Choose a fresh disposable profile path; existing data will not be reused or removed.' }
$evidenceRoot = [System.IO.Path]::GetFullPath($EvidenceDirectory)
if (Test-Path -LiteralPath $evidenceRoot) { throw 'Choose a new evidence directory to preserve previous results.' }
New-Item -ItemType Directory -Path $evidenceRoot | Out-Null
$desktopHome = Join-Path $evidenceRoot 'desktop-profile'
New-Item -ItemType Directory -Path $desktopHome | Out-Null
@{ environment=@{kind='wsl';distribution=$Distribution}; home=$ProfileHome } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $desktopHome 'desktop-selection.json') -Encoding utf8NoBOM
Copy-Item -LiteralPath (Join-Path $repoRoot 'docs/desktop-wsl-validation.md') -Destination (Join-Path $evidenceRoot 'checklist.md')
Push-Location $repoRoot
$previousSmokeHome = $env:ABYSSUS_SMOKE_HOME
try {
  $sha = & git rev-parse HEAD
  @("Source: $sha", "Windows: $([Environment]::OSVersion.VersionString)", "Selected distro: $Distribution", "Profile: $ProfileHome", $inventory) | Set-Content -LiteralPath (Join-Path $evidenceRoot 'environment.txt')
  & $wslExe --distribution $Distribution --exec /opt/abyssus/runtime/bin/node --input-type=module -e 'import {runtimeChecks} from "/opt/abyssus/app/desktop/runtime-check.js";const checks=await runtimeChecks();console.log(JSON.stringify(checks,null,2));if(checks.slice(0,5).some(c=>!c.ok))process.exitCode=1;' *> (Join-Path $evidenceRoot 'runtime-checks.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Staged runtime prerequisites failed; inspect runtime-checks.txt. No automatic repair was attempted.' }
  & npm.cmd ci *> (Join-Path $evidenceRoot 'npm-ci.txt')
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
  & npm.cmd run desktop:build *> (Join-Path $evidenceRoot 'build.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
  & npm.cmd run desktop:smoke *> (Join-Path $evidenceRoot 'windows-shell-smoke.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Windows shell smoke failed.' }
  Copy-Item -LiteralPath (Join-Path $repoRoot 'test-results/electron-win32.png') -Destination $evidenceRoot
  $env:ABYSSUS_SMOKE_HOME = $desktopHome
  Write-Host "Complete the checkpoints in $evidenceRoot\checklist.md. Choose Initialize on the first launch. Close normally; no data is deleted."
  & (Join-Path $repoRoot 'node_modules/.bin/electron.cmd') (Join-Path $repoRoot 'tests/desktop-electron-entry.cjs') *> (Join-Path $evidenceRoot 'desktop-log.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Desktop exited unsuccessfully; retain all evidence.' }
  Write-Host "Logs and checklist retained at $evidenceRoot. Manual checkpoints are not automatically marked passed."
} finally {
  $env:ABYSSUS_SMOKE_HOME = $previousSmokeHome
  Pop-Location
}
