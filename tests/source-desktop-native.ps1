param([Parameter(Mandatory=$true)][string]$FixtureRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$taskSource=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskIdentity=[Security.Principal.WindowsIdentity]::GetCurrent().User
. (Join-Path $taskSource 'scripts/source-bootstrap-native.ps1')
$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $taskSource 'scripts/source-desktop.ps1'),[ref]$null,[ref]$errors)
if ($errors) { throw 'Source script parser failure' }
foreach($definition in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)) { Invoke-Expression $definition.Extent.Text }
$taskRuntime=$null
function Refuses($Body,[string]$CaseName) { try { & $Body; throw "Unexpected allowance: $CaseName" } catch { if($_.Exception.Message -like 'Unexpected allowance:*') { throw }; Write-Output "PASS $CaseName" } }
$fixture=Join-Path $FixtureRoot ('native-'+[guid]::NewGuid().ToString('N'))
try {
 Private-Directory $fixture -Create
 $taskRuntime=$fixture;[IO.Directory]::CreateDirectory((Join-Path $fixture 'temp'))|Out-Null
 $file=Join-Path $fixture 'regular';[IO.File]::WriteAllText($file,'fixture')
 $keep=$script:SourcePins.Count;[void](Pin-SourcePath $file -Private);No-AlternateStreams $file;Close-SourcePins $keep
 foreach($name in @('..\escape','CONIN$','file:stream',('COM'+[char]0xb9))) { Refuses { Assert-SourcePath (Join-Path $fixture $name) } "native alias $name" }
 [IO.File]::WriteAllText($file+':extra','unexpected');Refuses { No-AlternateStreams $file } 'alternate stream refusal'
 Refuses { Assert-StreamInventory $false (New-Object byte[] 65536) } 'unknown native stream API failure refuses'
 $hard=Join-Path $fixture 'hard';New-Item -ItemType HardLink -Path $hard -Target $file|Out-Null
 Refuses { [void](Pin-SourcePath $hard) } 'actual hardlink refusal';Close-SourcePins $keep
 $outside=Join-Path $FixtureRoot ('outside-'+[guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($outside)|Out-Null
 $junction=Join-Path $fixture 'junction';New-Item -ItemType Junction -Path $junction -Target $outside|Out-Null
 Refuses { Private-Directory (Join-Path $junction 'must-not-exist') -Create } 'junction parent refused before directory/ACL effect'
 if (Test-Path -LiteralPath (Join-Path $outside 'must-not-exist')) { throw 'Alias created external residue' }
 $exe=(Get-Process -Id $PID).Path
 $saved=$env:STARK_API_KEY;$env:STARK_API_KEY='SYNTHETIC_SOURCE_SECRET'
 try { $reply=Run-Tool $exe @('-NoProfile','-Command','if($env:STARK_API_KEY -or $env:NODE_OPTIONS -or $env:GIT_CONFIG_COUNT){exit 9};[Console]::Write("clean")');if($reply -cne 'clean') {throw 'Unexpected tool result'} } finally {$env:STARK_API_KEY=$saved}
 Refuses { Run-Tool $exe @('-NoProfile','-Command','[Console]::Write(("x"*300000))') } 'bounded stdout before buffering full reply'
 Refuses { Run-Tool $exe @('-NoProfile','-Command','[Console]::Error.Write(("x"*300000))') } 'bounded concurrent stderr'
 Refuses { Run-Tool $exe @('-NoProfile','-Command','Start-Sleep -Seconds 5') '' 1 } 'owned process timeout'
 # Actual OS handles are closed while the child stays live; EOF cannot evade its deadline.
 $closeCode='Add-Type -Name NativeClose -Namespace Test -MemberDefinition ''[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);'';[Test.NativeClose]::CloseHandle([Test.NativeClose]::GetStdHandle(-11));[Test.NativeClose]::CloseHandle([Test.NativeClose]::GetStdHandle(-12));Start-Sleep -Seconds 20'
 Refuses { Run-Tool $exe @('-NoProfile','-Command',$closeCode) '' 3 } 'absolute deadline after closed pipes'
 $log=Join-Path $fixture 'partial.log';Run-Tool $exe @('-NoProfile','-Command','[Console]::Write("retained")') $log
 Refuses { Run-Tool $exe @('-NoProfile','-Command','[Console]::Write("overwrite")') $log } 'exclusive retained log'
 if([IO.File]::ReadAllText($log) -cne 'retained') {throw 'Prior log overwritten'}
 $survival=Join-Path $fixture 'desktop-survived';$desktopLog=Join-Path $fixture 'desktop-overflow.log'
 $overflowCode='$stream=[Console]::OpenStandardOutput();$bytes=New-Object byte[] 65536;for($n=0;$n -lt 1100;$n++){$stream.Write($bytes,0,$bytes.Length)};Start-Sleep -Milliseconds 100;[IO.File]::WriteAllText('''+$survival.Replace("'","''")+''',''survived'')'
 Run-Tool $exe @('-NoProfile','-Command',$overflowCode) $desktopLog 0
 if (-not (Test-Path -LiteralPath $survival) -or (Get-Item -LiteralPath $desktopLog).Length -gt 67108864) {throw 'Desktop lifetime was lost or logging exceeded its cap'}
 Write-Output 'PASS GUI-lifetime output saturation drains without killing child (fixed child fixture)'
 Write-Output 'PASS native DACL/identity/stream/parent and bounded process fixtures; no Docker/device acceptance'
} finally {Close-SourcePins}
