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
 # Exercise the actual Windows Verify-Runtime function with only engine image lookup doubled.
 $payloadRoot=Join-Path $FixtureRoot ('payload-'+[guid]::NewGuid().ToString('N'));Private-Directory $payloadRoot -Create
 $taskRuntime=$payloadRoot;$taskContext='fixture';$taskEndpoint='npipe://./pipe/docker_engine';$taskEngine='fixture|linux|amd64|/engine|[]'
 foreach($directory in @('payload/app','desktop-data','logs','crashes','temp')) {[IO.Directory]::CreateDirectory((Join-Path $payloadRoot $directory))|Out-Null}
 $controller='sha256:'+('b'*64);$worker='sha256:'+('c'*64);$sourceCommit='a'*40
 [IO.File]::WriteAllText((Join-Path $payloadRoot 'controller.iid'),$controller);[IO.File]::WriteAllText((Join-Path $payloadRoot 'worker.iid'),$worker)
 $metadata=@{version=1;source=$sourceCommit;controllerImage=$controller;workerImage=$worker}
 $metadata|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $payloadRoot 'payload/app/container-runtime.json') -Encoding UTF8
 $provenance=@{version=1;source=$sourceCommit;controllerImage=$controller;workerImage=$worker;platform='win32';arch='x64'}
 $provenance|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $payloadRoot 'payload/provenance.json') -Encoding UTF8
 [IO.File]::WriteAllText((Join-Path $payloadRoot ('payload/snowman-'+[char]0x2603+'.txt')),'unicode')
 [IO.File]::WriteAllText((Join-Path $payloadRoot 'payload/.hidden'),'fixed hidden fixture')
 $manifestLines=@(Get-ChildItem -LiteralPath (Join-Path $payloadRoot 'payload') -Recurse -Force -File|ForEach-Object {(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant()+'  '+$_.FullName.Substring((Join-Path $payloadRoot 'payload').Length+1).Replace('\','/')})
 [IO.File]::WriteAllText((Join-Path $payloadRoot 'payload/SHA256SUMS'),($manifestLines -join "`n")+"`n",(New-Object Text.UTF8Encoding($false)))
 $inventory=(Get-FileHash -LiteralPath (Join-Path $payloadRoot 'payload/SHA256SUMS')).Hash.ToLowerInvariant()
 @{platform='win32';source=$sourceCommit;context=$taskContext;endpoint=$taskEndpoint;engine=$taskEngine;inventory=$inventory}|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $payloadRoot 'receipt.json') -Encoding UTF8
 $taskDocker='synthetic-image-observer-only'
 function Assert-Engine {} # Only engine inventory is synthetic in this native payload fixture.
 function Run-Tool([string]$Executable,[string[]]$Arguments,[string]$Log='', [int]$Seconds=30) {if($Executable -ne 'synthetic-image-observer-only' -or $Arguments[2] -ne 'image' -or $Arguments[3] -ne 'inspect'){throw 'Unexpected synthetic operation'};return $Arguments[4]}
 Verify-Runtime
 [IO.File]::WriteAllText((Join-Path $payloadRoot 'payload/extra'),'unexpected')
 Refuses {Verify-Runtime} 'actual complete Windows inventory rejects extra file'
 Write-Output 'PASS actual Windows inventory Unicode/hidden/native validation with synthetic image lookup'
 Write-Output 'PASS native DACL/identity/stream/parent and bounded process fixtures; no Docker/device acceptance'
} finally {Close-SourcePins}
