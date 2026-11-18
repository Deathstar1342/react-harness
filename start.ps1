[CmdletBinding()]
param([switch]$Check, [switch]$Help)

$ErrorActionPreference = 'Stop'
if ($Help) { Write-Output 'Usage: .\start.ps1 [-Check]'; exit 0 }

$npm = Get-Command $(if ($env:OS -eq 'Windows_NT') { 'npm.cmd' } else { 'npm' }) -ErrorAction Stop
node -e "if (Number(process.versions.node.split('.')[0]) < 24) { console.error('Node.js 24 or newer is required.'); process.exit(1); }"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Push-Location -LiteralPath $PSScriptRoot
try {
    if ($Check) {
        node --import tsx -e "if (!require('node:fs').existsSync('dist/client/index.html')) { console.error('Run npm run build or setup first.'); process.exit(1); }"
        exit $LASTEXITCODE
    }
    & $npm.Source start
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
