param([ValidateSet('setup','start')][string]$Action,[switch]$Check,[switch]$NoStart,[string]$RuntimeRoot,[switch]$Help)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($Help) { Write-Output 'Usage: .\setup.ps1 [-Check|-NoStart] [-RuntimeRoot D:\abysSUS-runtime]; .\start.ps1 [-Check]. Requires preexisting local Docker Desktop Linux engine. No host provisioning.'; exit 0 }
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) { throw 'Use Windows x64 PowerShell, or setup.sh on Linux.' }
$taskSource=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskRuntime=$null
$taskIdentity=[Security.Principal.WindowsIdentity]::GetCurrent().User
. (Join-Path $PSScriptRoot 'source-bootstrap-native.ps1')
trap { Close-SourcePins; throw $_ }
function Quote-Argument([string]$Value) { '"'+[regex]::Replace([regex]::Replace($Value,'(\\*)"','$1$1\"'),'(\\+)$','$1$1')+'"' }
function Run-Tool([string]$Executable,[string[]]$Arguments,[string]$Log='', [int]$Seconds=30) {
    $processInfo=New-Object Diagnostics.ProcessStartInfo
    $processInfo.FileName=$Executable; $processInfo.Arguments=(($Arguments | ForEach-Object { Quote-Argument $_ }) -join ' ')
    $processInfo.UseShellExecute=$false; $processInfo.CreateNoWindow=$true; $processInfo.WindowStyle='Hidden'
    $processInfo.WorkingDirectory=$taskSource; $processInfo.RedirectStandardOutput=$true; $processInfo.RedirectStandardError=$true
    $processInfo.EnvironmentVariables.Clear()
    foreach ($name in @('SystemRoot','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA','PATH','HOME')) { if ([Environment]::GetEnvironmentVariable($name)) { $processInfo.EnvironmentVariables[$name]=[Environment]::GetEnvironmentVariable($name) } }
    if ($taskRuntime) { $processInfo.EnvironmentVariables['TEMP']=(Join-Path $taskRuntime 'temp'); $processInfo.EnvironmentVariables['TMP']=(Join-Path $taskRuntime 'temp') }
    $process=New-Object Diagnostics.Process; $process.StartInfo=$processInfo; $started=$false
    $memory=New-Object IO.MemoryStream; $file=$null; $saturated=$false; $total=0L
    try {
        # Reserve a fresh log before starting anything. Never overwrite prior evidence.
        if ($Log) { $file=[IO.File]::Open($Log,'CreateNew','Write','Read') }
        if (-not $process.Start()) { throw 'Source tool failed to start' };$started=$true
        $watch=[Diagnostics.Stopwatch]::StartNew()
        $streams=@($process.StandardOutput.BaseStream,$process.StandardError.BaseStream)
        $buffers=@((New-Object byte[] 65536),(New-Object byte[] 65536)); $pending=@($null,$null);$done=@($false,$false)
        for ($i=0;$i -lt 2;$i++) { $pending[$i]=$streams[$i].ReadAsync($buffers[$i],0,65536) }
        while (-not ($done[0] -and $done[1])) {
            for ($i=0;$i -lt 2;$i++) {
                if (-not $done[$i] -and $pending[$i].IsCompleted) {
                    $count=$pending[$i].GetAwaiter().GetResult()
                    if ($count -eq 0) { $done[$i]=$true;continue }
                    $total+=$count;$limit=262144L;if ($Log) { $limit=67108864L }
                    if ($total -gt $limit -and $Seconds -gt 0) { throw 'Source output limit exceeded. Partial logs and uncertain intent are retained.' }
                    if ($total -gt $limit -and -not $saturated) { $saturated=$true;Write-Warning 'Desktop log limit reached. Further output is drained without saving; the desktop remains running.' }
                    if (-not $saturated) {
                        if ($file) {
                            try { $file.Write($buffers[$i],0,$count);$file.Flush() }
                            catch { if ($Seconds -gt 0) { throw };$saturated=$true;Write-Warning 'Desktop log is unavailable. Output will be drained; the desktop remains running.' }
                        } else { $memory.Write($buffers[$i],0,$count) }
                    }
                    $pending[$i]=$streams[$i].ReadAsync($buffers[$i],0,65536)
                }
            }
            if ($Seconds -gt 0 -and $watch.Elapsed.TotalSeconds -gt $Seconds) { throw 'Source operation timed out. Intent remains uncertain; nothing replayed.' }
            [Threading.Thread]::Sleep(1)
        }
        # EOF is not process exit. Preserve the same absolute deadline after both pipes close.
        if ($Seconds -gt 0) {
            $remaining=[int][Math]::Max(0,$Seconds*1000-$watch.ElapsedMilliseconds)
            if (-not $process.WaitForExit($remaining)) { throw 'Source exit deadline exceeded after output closed. Intent remains uncertain.' }
        } else { $process.WaitForExit() }
        if ($process.ExitCode -ne 0) { throw 'Source tool exited unsuccessfully. Inspect retained logs; nothing reset/replayed.' }
        if (-not $Log) { return [Text.Encoding]::UTF8.GetString($memory.ToArray()).TrimEnd() }
    } finally {
        # GUI lifetime belongs to the user. Logging/launcher failures cannot kill their desktop.
        if ($Seconds -gt 0 -and $started -and -not $process.HasExited) { $process.Kill() }
        if ($file) { try { $file.Flush($true) } catch { if ($Seconds -gt 0) { Write-Warning 'Partial source log could not be flushed.' } };$file.Dispose() }
        $memory.Dispose();$process.Dispose()
    }
}
function No-Links([string]$Value) {
    $item=Get-Item -LiteralPath $Value -Force
    while ($null -ne $item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Source runtime links/reparse points are refused.' }
        if ($item -is [IO.FileInfo]) { $item=$item.Directory } else { $item=$item.Parent }
    }
}
function Private-Directory([string]$Value,[switch]$Create) {
    if ($Create) {
        if (Test-Path -LiteralPath $Value) { throw 'New setup requires an absent directory. Existing files are preserved.' }
        Assert-SourcePath $Value
        [void](Pin-SourcePath ([IO.Path]::GetDirectoryName($Value)))
        if (-not $script:SourceNative::CreateDirectoryW($Value,[IntPtr]::Zero)) { throw 'Exclusive source directory creation refused' }
        [void](Pin-SourcePath $Value)
        $acl=New-Object Security.AccessControl.DirectorySecurity
        $acl.SetOwner($taskIdentity); $acl.SetAccessRuleProtection($true,$false)
        foreach ($sid in @($taskIdentity.Value,'S-1-5-18','S-1-5-32-544')) {
            $rule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')
            $acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $Value -AclObject $acl
    }
    [void](Pin-SourcePath $Value -Private)
    if (-not (Test-Path -LiteralPath $Value -PathType Container)) { throw 'Selected runtime directory is unavailable; no replacement created.' }
    $acl=Get-Acl -LiteralPath $Value
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $taskIdentity.Value) { throw 'Source runtime must have a protected user-owned DACL.' }
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($taskIdentity.Value,'S-1-5-18','S-1-5-32-544')) { throw 'Source runtime grants access outside the private account boundary.' }
    }
}
foreach ($name in @('DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DOCKER_API_VERSION')) { if ([Environment]::GetEnvironmentVariable($name)) { throw "Remove inherited $name before source setup/start." } }
$taskDocker=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Docker\Docker\resources\bin\docker.exe'
if (-not (Test-Path -LiteralPath $taskDocker -PathType Leaf)) { throw 'Docker Desktop is unavailable. Install/start it through your approved administrator; this script changes no host settings.' }
[void](Pin-SourcePath $taskDocker -TrustedProgram)
$taskContext=Run-Tool $taskDocker @('context','show')
if ($taskContext -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$') { throw 'Invalid local Docker context' }
$taskEndpoint=Run-Tool $taskDocker @('context','inspect',$taskContext,'--format','{{.Endpoints.docker.Host}}')
if ($taskEndpoint -notmatch '^npipe:(?://|////)\./pipe/(?:docker_engine|dockerDesktopLinuxEngine)$') { throw 'Only the local Docker Desktop named-pipe engine is supported.' }
$taskEngine=Run-Tool $taskDocker @('--context',$taskContext,'info','--format','{{.ID}}|{{.OSType}}|{{.Architecture}}|{{.DockerRootDir}}|{{json .SecurityOptions}}')
if ($taskEngine -notmatch '\|linux\|(amd64|x86_64)\|' -or $taskEngine -match 'rootless|userns') { throw 'A local Linux x64 engine with the supported user mapping is required.' }
$taskBuilderReply=Run-Tool $taskDocker @('--context',$taskContext,'buildx','inspect',$taskContext)
$drivers=[regex]::Matches($taskBuilderReply,'(?m)^Driver:[ \t]*([^\r\n]+)\r?$')
$endpoints=[regex]::Matches($taskBuilderReply,'(?m)^Endpoint:[ \t]*([^\r\n]+)\r?$')
if ($drivers.Count -ne 1 -or $endpoints.Count -ne 1) { throw 'Ambiguous local build driver' }
$taskBuilder=$drivers[0].Groups[1].Value+'|'+$endpoints[0].Groups[1].Value
if ($taskBuilder -notin @("docker|$taskContext","docker|$taskEndpoint")) { throw 'Use the local context Docker build driver; remote/custom builders are refused.' }
Write-Output ('Engine data root inside Docker: '+$taskEngine.Split('|')[3]+'. Actual Windows backing/cache drive is unknown. Selecting D: below does not move Docker storage.')
if ($Action -eq 'setup' -and $Check) { Close-SourcePins; exit 0 }
$taskSelectionDir=Join-Path $taskSource '.container-desktop-source'
$taskSelection=Join-Path $taskSelectionDir 'selection'
function Verify-Runtime {
    Private-Directory $taskRuntime
    $receiptPath=Join-Path $taskRuntime 'receipt.json'; No-Links $receiptPath
    if ((Get-Item -LiteralPath $receiptPath).Length -gt 16384) { throw 'Receipt size limit' }; $receipt=Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    if (@($receipt.PSObject.Properties).Count -ne 6) { throw 'Invalid receipt shape' }
    if ($receipt.platform -ne 'win32' -or $receipt.source -notmatch '^[a-f0-9]{40}$' -or $receipt.context -cne $taskContext -or $receipt.endpoint -cne $taskEndpoint -or $receipt.engine -cne $taskEngine -or $receipt.inventory -notmatch '^[a-f0-9]{64}$') { throw 'Runtime/engine identity changed or setup is incomplete. Nothing replayed.' }
    $payload=Join-Path $taskRuntime 'payload'; No-Links $payload
    $manifest=Join-Path $payload 'SHA256SUMS'; No-Links $manifest
    if ((Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant() -cne $receipt.inventory) { throw 'Runtime inventory changed' }
    if ((Get-Item -LiteralPath $manifest).Length -gt 16777216) { throw 'Manifest size limit' }
    $seen=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($line in [IO.File]::ReadAllLines($manifest)) {
        if ($line -notmatch '^([a-f0-9]{64})  ([^\x00-\x1f\\:]+)$') { throw 'Invalid runtime manifest entry' }
        $hash=$Matches[1]; $relative=$Matches[2]
        if ($relative.StartsWith('/') -or ($relative.Split('/') | Where-Object { $_ -in @('','..','.') -or $_ -match '[. ]$|^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)' }) -or -not $seen.Add($relative)) { throw 'Unsafe/colliding runtime manifest member' }
        if ($relative -match '^app/.*(\.node$|/node-pty/)') { throw 'Host backend native dependency in desktop payload' }
        $file=Join-Path $payload $relative; $keep=$script:SourcePins.Count; [void](Pin-SourcePath $file -Private); No-AlternateStreams $file
        if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hash) { throw 'Runtime payload is missing or changed' }
        Close-SourcePins $keep
        if ($seen.Count -gt 50000) { throw 'Runtime member limit' }
    }
    $files=@(Get-ChildItem -LiteralPath $payload -Recurse -Force)
    foreach ($file in $files) { if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime reparse point refused' } }
    if (@($files | Where-Object { -not $_.PSIsContainer }).Count -ne $seen.Count+1) { throw 'Extra/missing runtime files' }
    foreach ($name in @('desktop-data','logs','crashes','temp')) { No-Links (Join-Path $taskRuntime $name) }
    foreach($metadata in @('app/container-runtime.json','provenance.json')) { if ((Get-Item -LiteralPath (Join-Path $payload $metadata)).Length -gt 16384) { throw 'Payload metadata size limit' } }
    $payloadMetadata=Get-Content -LiteralPath (Join-Path $payload 'app/container-runtime.json') -Raw | ConvertFrom-Json
    $provenance=Get-Content -LiteralPath (Join-Path $payload 'provenance.json') -Raw | ConvertFrom-Json
    if ($payloadMetadata.source -cne $receipt.source -or $provenance.source -cne $receipt.source -or $provenance.platform -cne 'win32') { throw 'Payload source/platform binding mismatch' }
    foreach ($name in @('controller','worker')) {
        $iid=[IO.File]::ReadAllText((Join-Path $taskRuntime "$name.iid")).Trim()
        $property=$name+'Image'; if ($payloadMetadata.$property -cne $iid -or $provenance.$property -cne $iid) { throw 'Payload immutable image binding mismatch' }
        if ($iid -notmatch '^sha256:[a-f0-9]{64}$' -or (Run-Tool $taskDocker @('--context',$taskContext,'image','inspect',$iid,'--format','{{.Id}}')) -cne $iid) { throw 'Exact runtime image missing. Start never pulls/builds.' }
    }
}
if (Test-Path -LiteralPath $taskSelection) {
    Private-Directory $taskSelectionDir; No-Links $taskSelection
    if ((Get-Item -LiteralPath $taskSelection).Length -gt 4096) { throw 'Selection size limit' }; $saved=[IO.File]::ReadAllLines($taskSelection)
    if ($saved.Count -ne 1) { throw 'Invalid saved source runtime selection' }
    $taskRuntime=$saved[0]
    if ($RuntimeRoot -and $RuntimeRoot -cne $taskRuntime) { throw 'Existing selection cannot be silently relocated' }
    Verify-Runtime
} else {
    if ($Action -ne 'setup') { throw 'Run setup.ps1 once to select the source runtime directory.' }
    if (Test-Path -LiteralPath $taskSelectionDir) { throw 'Interrupted selection exists; preserve it for recovery.' }
    if (-not $RuntimeRoot) { $RuntimeRoot=Read-Host 'Absolute new external runtime/build/cache directory (for example D:\abysSUS-runtime)' }
    if ($RuntimeRoot -notmatch '^[A-Za-z]:\\[^\x00-\x1f<>"|?*:,]+$' -or $RuntimeRoot.Split('\') -match '^\.{1,2}$|[. ]$' -or [IO.Path]::GetFullPath($RuntimeRoot) -cne $RuntimeRoot) { throw 'Choose a canonical local drive path without aliases.' }
    if ($RuntimeRoot.StartsWith($taskSource+'\',[StringComparison]::OrdinalIgnoreCase) -or $taskSource.StartsWith($RuntimeRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or $RuntimeRoot -ieq $taskSource -or $RuntimeRoot -ieq $env:USERPROFILE) { throw 'Choose a runtime directory separate from source and your home.' }
    $drive=New-Object IO.DriveInfo([IO.Path]::GetPathRoot($RuntimeRoot))
    if ($drive.DriveType -ne 'Fixed' -or $drive.DriveFormat -ne 'NTFS') { throw 'Use a local fixed NTFS drive.' }
    $taskGit=(Get-Command git -CommandType Application).Source
    if (Run-Tool $taskGit @('-c','core.fsmonitor=false','-c','core.hooksPath=NUL','-c','core.attributesFile=NUL','-C',$taskSource,'status','--porcelain','--untracked-files=no')) { throw 'Commit or preserve tracked edits before building an exact source snapshot.' }
    $sourceCommit=Run-Tool $taskGit @('-c','core.fsmonitor=false','-c','core.hooksPath=NUL','-c','core.attributesFile=NUL','-C',$taskSource,'rev-parse','HEAD')
    if ($sourceCommit -notmatch '^[a-f0-9]{40}$') { throw 'Exact Git source commit required' }
    $taskRuntime=$RuntimeRoot; Private-Directory $taskRuntime -Create
    foreach ($name in @('snapshot','desktop-data','logs','crashes','temp')) { [IO.Directory]::CreateDirectory((Join-Path $taskRuntime $name)) | Out-Null }
    Private-Directory $taskSelectionDir -Create
    [IO.File]::WriteAllText($taskSelection,$taskRuntime+"`n")
    [IO.File]::WriteAllText((Join-Path $taskRuntime 'build-intent'),$sourceCommit+"`n"); Flush-SourceFile (Join-Path $taskRuntime 'build-intent'); Flush-SourceFile $taskSelection
    $tree=Run-Tool $taskGit @('-c','core.fsmonitor=false','-c','core.hooksPath=NUL','-C',$taskSource,'ls-tree','-r','--long',$sourceCommit)
    $totalBytes=0L;$members=0
    foreach ($line in $tree.Split("`n")) {
        if ($line -notmatch '^100(644|755) blob [a-f0-9]{40} +([0-9]+)	([^
]+)$') { throw 'Source tree links/special modes or escaped names refused before extraction' }
        $totalBytes+=[long]$Matches[2];$members++;Assert-SourcePath (Join-Path (Join-Path $taskRuntime 'snapshot') $Matches[3].Replace('/','\'))
        if ($totalBytes -gt 268435456 -or $members -gt 20000) { throw 'Source tree size/count limit' }
    }
    $archive=Join-Path $taskRuntime 'source.tar'
    Run-Tool $taskGit @('-c','core.fsmonitor=false','-c','core.hooksPath=NUL','-c','core.attributesFile=NUL','-C',$taskSource,'archive','--format=tar',"--output=$archive",$sourceCommit,'.dockerignore','package.json','package-lock.json','tsconfig.json','vite.config.ts','index.html','client','server','shared','desktop','containers','helper/core.py','helper/apt_adapter.py','helper/apt.conf','scripts/desktop-build.mjs','scripts/stage-support-runtime.py','scripts/stage-container-runtime.py','scripts/source-payload.py','scripts/source-payload-verify.py')
    Run-Tool (Join-Path $env:SystemRoot 'System32\tar.exe') @('-xf',$archive,'-C',(Join-Path $taskRuntime 'snapshot'))
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $taskRuntime 'snapshot') -Recurse -Force) { if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Source snapshot links refused' } }
    foreach ($name in @('controller','worker')) {
        $dockerfile='containers/Dockerfile'; if ($name -eq 'worker') { $dockerfile='containers/Worker.Dockerfile' }
        [IO.File]::AppendAllText((Join-Path $taskRuntime 'build-intent'),"build-$name`n"); Flush-SourceFile (Join-Path $taskRuntime 'build-intent')
        Run-Tool $taskDocker @('--context',$taskContext,'buildx','build','--builder',$taskContext,'--load','--iidfile',(Join-Path $taskRuntime "$name.iid"),'-f',(Join-Path $taskRuntime "snapshot/$dockerfile"),(Join-Path $taskRuntime 'snapshot')) (Join-Path $taskRuntime "logs/$name-build.log") 1800
    }
    [IO.File]::AppendAllText((Join-Path $taskRuntime 'build-intent'),"build-export-payload`n"); Flush-SourceFile (Join-Path $taskRuntime 'build-intent')
    $controller=[IO.File]::ReadAllText((Join-Path $taskRuntime 'controller.iid')).Trim(); $worker=[IO.File]::ReadAllText((Join-Path $taskRuntime 'worker.iid')).Trim()
    Run-Tool $taskDocker @('--context',$taskContext,'buildx','build','--builder',$taskContext,'--build-arg','TARGET_OS=win32','--build-arg',"SOURCE_COMMIT=$sourceCommit",'--build-arg',"CONTROLLER_IMAGE=$controller",'--build-arg',"WORKER_IMAGE=$worker",'--output',"type=local,dest=$taskRuntime/payload",'-f',(Join-Path $taskRuntime 'snapshot/containers/Source.Dockerfile'),(Join-Path $taskRuntime 'snapshot')) (Join-Path $taskRuntime 'logs/payload-build.log') 1800
    $inventory=(Get-FileHash -LiteralPath (Join-Path $taskRuntime 'payload/SHA256SUMS') -Algorithm SHA256).Hash.ToLowerInvariant()
    @{platform='win32';source=$sourceCommit;context=$taskContext;endpoint=$taskEndpoint;engine=$taskEngine;inventory=$inventory} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $taskRuntime 'receipt.json') -Encoding UTF8
    Flush-SourceFile (Join-Path $taskRuntime 'receipt.json')
    Verify-Runtime
}
if ($Check -or $NoStart) { Close-SourcePins; Write-Output 'Source runtime inventory and exact engine images verified. App storage/provider setup remains in the native desktop.'; exit 0 }
# The verified native desktop owns all container effects and private provider setup.
Run-Tool (Join-Path $taskRuntime 'payload/electron/electron.exe') @((Join-Path $taskRuntime 'payload/app/desktop/source-entry.cjs')) (Join-Path $taskRuntime ('logs/desktop-'+[guid]::NewGuid().ToString()+'.log')) 0

Close-SourcePins
