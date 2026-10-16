param([switch]$Check,[switch]$NoStart,[string]$RuntimeRoot,[switch]$Help)
& (Join-Path $PSScriptRoot 'scripts/source-desktop.ps1') -Action setup -Check:$Check -NoStart:$NoStart -RuntimeRoot $RuntimeRoot -Help:$Help
