$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Installer transactions require an authorized disposable CI machine.' }
$testRoot = Join-Path $env:RUNNER_TEMP 'abyssus-installer'
$fixtureRoot = $testRoot
. "$PSScriptRoot/windows-fixture-process.ps1"
$install = Join-Path $testRoot 'app'
$data = Join-Path $testRoot 'data'
New-Item -ItemType Directory -Force $data | Out-Null
New-Item 'HKCU:\Software\abysSUS\Storage' -Force | Out-Null
Set-ItemProperty 'HKCU:\Software\abysSUS\Storage' -Name DataFolder -Value $data
$setup = (Get-Item 'build/release/*setup.exe').FullName
function Install-Candidate {
  param([string]$phase)
  Invoke-FixturePhase -Phase $phase -FilePath $setup -Arguments @('/S', "/D=$install") -TimeoutSeconds 240
}
Write-Output "FIXTURE install=$install data=$data setup=$setup"
Install-Candidate 'install'
Invoke-FixturePhase -Phase 'installed-preflight' -FilePath 'node' -Arguments @('tests/installed-package-preflight.cjs',(Join-Path $install 'abysSUS.exe'),$data)
$env:ABYSSUS_PACKAGE_TEST_HOME = $data
$env:ABYSSUS_TEST_INSTALLER = $setup
Invoke-FixturePhase -Phase 'installed-smoke' -FilePath 'node' -Arguments @('tests/packaged-smoke.ts',(Join-Path $install 'abysSUS.exe'),'create')
Invoke-FixturePhase -Phase 'replacement-refusal' -FilePath $setup -Arguments @('/S',"/D=$install") -ExpectedExit @(74)
$uninstaller = (Get-Item (Join-Path $install 'Uninstall*.exe')).FullName
# NSIS normally copies its uninstaller to TEMP. Run that same payload outside
# INSTDIR so the explicit synchronous _?= fixture does not lock its own file.
$uninstallFixture = Join-Path $testRoot 'uninstall-fixture.exe'
Copy-Item -LiteralPath $uninstaller -Destination $uninstallFixture
Invoke-FixturePhase -Phase 'uninstall' -FilePath $uninstallFixture -Arguments @('/S',"_?=$install") -TimeoutSeconds 120
if (Test-Path -LiteralPath (Join-Path $install 'abysSUS.exe')) { throw 'Application payload survived uninstall' }
if ((Get-Content -LiteralPath (Join-Path $data 'preserve.txt') -Raw) -ne 'package-preservation-fixture') { throw 'Desktop data lost' }
if ((Get-ItemProperty 'HKCU:\Software\abysSUS\Storage').DataFolder -ne $data) { throw 'Saved location lost' }
Install-Candidate 'reinstall'
Invoke-FixturePhase -Phase 'reinstalled-preflight' -FilePath 'node' -Arguments @('tests/installed-package-preflight.cjs',(Join-Path $install 'abysSUS.exe'),$data)
Invoke-FixturePhase -Phase 'reinstalled-smoke' -FilePath 'node' -Arguments @('tests/packaged-smoke.ts',(Join-Path $install 'abysSUS.exe'),'verify')
Invoke-FixturePhase -Phase 'crash' -FilePath 'node' -Arguments @('tests/packaged-crash.ts',(Join-Path $install 'abysSUS.exe'))
Invoke-FixturePhase -Phase 'restart-after-crash' -FilePath 'node' -Arguments @('tests/packaged-smoke.ts',(Join-Path $install 'abysSUS.exe'),'verify')
Write-Output 'PASS actual NSIS install, repeat-install refusal, uninstall/reinstall and data-location preservation'
