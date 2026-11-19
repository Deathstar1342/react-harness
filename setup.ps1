[CmdletBinding()]
param([switch]$Check, [switch]$NoStart, [switch]$Help)

$ErrorActionPreference = 'Stop'
if ($Help) { Write-Output 'Usage: .\setup.ps1 [-Check|-NoStart]'; exit 0 }

$npm = Get-Command $(if ($env:OS -eq 'Windows_NT') { 'npm.cmd' } else { 'npm' }) -ErrorAction Stop
node -e "if (Number(process.versions.node.split('.')[0]) < 24) { console.error('Node.js 24 or newer is required.'); process.exit(1); }"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Push-Location -LiteralPath $PSScriptRoot
try {
    if ($Check) { exit 0 }
    & $npm.Source ci
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Output 'Ready. Run npm start from this checkout.'
} finally {
    Pop-Location
}
