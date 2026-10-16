param([switch]$Check,[switch]$Help)
& (Join-Path $PSScriptRoot 'scripts/source-desktop.ps1') -Action start -Check:$Check -Help:$Help
