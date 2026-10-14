$ErrorActionPreference='Stop'
$fixtureRoot=Join-Path $env:RUNNER_TEMP 'abyssus-crash-diagnostic'
New-Item -ItemType Directory -Force $fixtureRoot | Out-Null
. "$PSScriptRoot/windows-fixture-process.ps1"
$env:ABYSSUS_PACKAGE_TEST_HOME=$fixtureRoot
$exe=(Get-Item 'build/release/win-unpacked/abysSUS.exe').FullName
Invoke-FixturePhase -Phase 'diagnostic-smoke' -FilePath 'node' -Arguments @('tests/packaged-smoke.ts',$exe,'create')
Invoke-FixturePhase -Phase 'diagnostic-crash' -FilePath 'node' -Arguments @('tests/packaged-crash.ts',$exe)
Invoke-FixturePhase -Phase 'diagnostic-restart' -FilePath 'node' -Arguments @('tests/packaged-smoke.ts',$exe,'verify')
