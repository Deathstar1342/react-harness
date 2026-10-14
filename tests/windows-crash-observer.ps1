$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Disposable CI only' }
$fixturePid = [int]$env:ABYSSUS_CRASH_PID
$fixtureExe = $env:ABYSSUS_CRASH_EXE
$owned = [Diagnostics.Process]::GetProcessById($fixturePid)
try {
  if (-not $owned.MainModule.FileName.Equals($fixtureExe,[StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture executable identity changed' }
  $null = $owned.Handle # Open the exact process handle before termination.
  function Snapshot {
    @(Get-CimInstance Win32_Process -Filter "Name='abysSUS.exe'" | Where-Object { $_.ExecutablePath -eq $fixtureExe } | ForEach-Object {
      $kind = if ($_.CommandLine -match '--type=([^ ]+)') { $Matches[1] } else { 'main' }
      [pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;kind=$kind}
    })
  }
  @{event='ready';pid=$fixturePid;path=$owned.MainModule.FileName;processes=@(Snapshot)} | ConvertTo-Json -Compress -Depth 4
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $exited = $owned.WaitForExit(15000)
  @{event='process-handle';exited=$exited;elapsedMs=$watch.ElapsedMilliseconds;processes=@(Snapshot)} | ConvertTo-Json -Compress -Depth 4
  if (-not $exited) { exit 1 }
} finally { $owned.Dispose() }
