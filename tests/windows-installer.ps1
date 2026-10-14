$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Installer transactions require an authorized disposable CI machine.' }
$testRoot = Join-Path $env:RUNNER_TEMP 'abyssus-installer'
$install = Join-Path $testRoot 'app'
$data = Join-Path $testRoot 'data'
New-Item -ItemType Directory -Force $data | Out-Null
New-Item 'HKCU:\Software\abysSUS\Storage' -Force | Out-Null
Set-ItemProperty 'HKCU:\Software\abysSUS\Storage' -Name DataFolder -Value $data
$setup = (Get-Item 'build/release/*setup.exe').FullName
function Install-Candidate {
  $p = Start-Process -FilePath $setup -ArgumentList @('/S', "/D=$install") -WindowStyle Hidden -PassThru -Wait
  if ($p.ExitCode -ne 0) { throw "Installer failed: $($p.ExitCode)" }
}
Install-Candidate
$env:ABYSSUS_PACKAGE_TEST_HOME = $data
$env:ABYSSUS_TEST_INSTALLER = $setup
node tests/packaged-smoke.ts (Join-Path $install 'abysSUS.exe') create
if ($LASTEXITCODE -ne 0) { throw 'Installed executable check failed' }
$p = Start-Process -FilePath $setup -ArgumentList @('/S', "/D=$install") -WindowStyle Hidden -PassThru -Wait
if ($p.ExitCode -eq 0) { throw 'In-place replacement was not refused' }
$uninstaller = (Get-Item (Join-Path $install 'Uninstall*.exe')).FullName
$p = Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$install") -WindowStyle Hidden -PassThru -Wait
if ($p.ExitCode -ne 0) { throw 'Uninstall failed' }
if ((Get-Content -LiteralPath (Join-Path $data 'preserve.txt') -Raw) -ne 'package-preservation-fixture') { throw 'Desktop data lost' }
if ((Get-ItemProperty 'HKCU:\Software\abysSUS\Storage').DataFolder -ne $data) { throw 'Saved location lost' }
Install-Candidate
node tests/packaged-smoke.ts (Join-Path $install 'abysSUS.exe') verify
if ($LASTEXITCODE -ne 0) { throw 'Reinstalled executable check failed' }
node tests/packaged-crash.ts (Join-Path $install 'abysSUS.exe')
if ($LASTEXITCODE -ne 0) { throw 'Owned crash recovery check failed' }
Write-Output 'PASS actual NSIS install, repeat-install refusal, uninstall/reinstall and data-location preservation'
