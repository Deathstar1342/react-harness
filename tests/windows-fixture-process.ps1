if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Disposable CI only' }
$diagnosticsRoot = Join-Path (Get-Location) 'test-results/m21-windows'
New-Item -ItemType Directory -Force $diagnosticsRoot | Out-Null
function Invoke-FixturePhase {
  param([string]$Phase,[string]$FilePath,[string[]]$Arguments,[int]$TimeoutSeconds=90,[int[]]$ExpectedExit=@(0))
  $file = (Get-Command $FilePath -ErrorAction Stop).Source
  $start = [Diagnostics.ProcessStartInfo]::new($file)
  $start.UseShellExecute=$false; $start.CreateNoWindow=$true
  $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
  foreach($argument in $Arguments){$start.ArgumentList.Add($argument)}
  $child=[Diagnostics.Process]::new();$child.StartInfo=$start
  Write-Output "$(Get-Date -AsUTC -Format o) START $Phase file=$file args=$($Arguments -join ' ') limit=${TimeoutSeconds}s"
  if(-not $child.Start()){throw 'Fixture process did not start'}
  Write-Output "$(Get-Date -AsUTC -Format o) OWNED $Phase pid=$($child.Id)"
  $stdout=$child.StandardOutput.ReadToEndAsync();$stderr=$child.StandardError.ReadToEndAsync()
  try {
    if(-not $child.WaitForExit($TimeoutSeconds*1000)){throw 'Owned phase process timed out'}
    Write-Output "$(Get-Date -AsUTC -Format o) PROCESS-EXIT $Phase pid=$($child.Id) code=$($child.ExitCode)"
    if(-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout,$stderr),5000)){throw 'Parent exited but descendant output pipes remain open'}
    [IO.File]::WriteAllText((Join-Path $diagnosticsRoot "$Phase.log"),$stdout.Result+$stderr.Result)
    Write-Output $stdout.Result
    if($stderr.Result){Write-Output $stderr.Result}
    if($child.ExitCode -notin $ExpectedExit){throw "Unexpected fixture exit $($child.ExitCode)"}
    Write-Output "$(Get-Date -AsUTC -Format o) END $Phase"
  } catch {
    $failure="$(Get-Date -AsUTC -Format o) QUARANTINED $Phase pid=$($child.Id) exited=$($child.HasExited) file=$file root=$fixtureRoot reason=$($_.Exception.Message)"
    Write-Output $failure
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'QUARANTINED.txt'),$failure)
    [IO.File]::WriteAllText((Join-Path $diagnosticsRoot "$Phase-failure.txt"),$failure)
    try { Get-CimInstance Win32_Process -Filter "ProcessId=$($child.Id) OR ParentProcessId=$($child.Id)" -OperationTimeoutSec 5 | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress } catch { Write-Output 'Process diagnostic unavailable; original failure retained' }
    if($stdout.IsCompleted){Write-Output $stdout.Result}
    if($stderr.IsCompleted){Write-Output $stderr.Result}
    throw # Never retry a timed-out or uncertain installer mutation.
  } finally {$child.Dispose()}
}
