$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Disposable CI only' }
$fixturePid = [int]$env:ABYSSUS_CRASH_PID
$fixtureExe = $env:ABYSSUS_CRASH_EXE
$owned = [Diagnostics.Process]::GetProcessById($fixturePid)
try {
  if (-not $owned.MainModule.FileName.Equals($fixtureExe,[StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture executable identity changed' }
  $null = $owned.Handle # Open the exact process handle before termination.
  $mainRecord=Get-CimInstance Win32_Process -Filter "ProcessId=$fixturePid" -OperationTimeoutSec 5
  $launcherPid=[int]$env:ABYSSUS_CRASH_PARENT
  if($mainRecord.ParentProcessId -ne $launcherPid){throw 'Electron main is not the owned launcher child'}
  $launcher=Get-CimInstance Win32_Process -Filter "ProcessId=$launcherPid" -OperationTimeoutSec 5
  if(-not $launcher.ExecutablePath.Equals((Join-Path $env:SystemRoot 'System32/cmd.exe'),[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected Windows launcher executable'}
  function Snapshot {
    @(Get-CimInstance Win32_Process -Filter "Name='abysSUS.exe'" -OperationTimeoutSec 5 | Where-Object { $_.ExecutablePath -eq $fixtureExe } | ForEach-Object {
      $kind = if ($_.CommandLine -match '--type=([^ ]+)') { $Matches[1] } else { 'main' }
      [pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;kind=$kind}
    })
  }
  @{event='ready';pid=$fixturePid;path=$owned.MainModule.FileName;launcherPid=$launcherPid;launcherPath=$launcher.ExecutablePath;processes=@(Snapshot)} | ConvertTo-Json -Compress -Depth 4
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $exited = $owned.WaitForExit(15000)
  @{event='process-handle';exited=$exited;elapsedMs=$watch.ElapsedMilliseconds;processes=@(Snapshot)} | ConvertTo-Json -Compress -Depth 4
  if (-not $exited) { exit 1 }
} finally { $owned.Dispose() }
