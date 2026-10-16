# In-memory P/Invoke declarations: no compiler, temporary assembly or host installation.
$assemblyName=New-Object Reflection.AssemblyName('AbyssusSourceNative')
if ($PSVersionTable.PSEdition -eq 'Core') { $assembly=[Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly($assemblyName,[Reflection.Emit.AssemblyBuilderAccess]::Run) }
else { $assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName,[Reflection.Emit.AssemblyBuilderAccess]::Run) }
$module=$assembly.DefineDynamicModule('Native'); $nativeType=$module.DefineType('SourceNative','Public,Sealed,Abstract')
function Native-Method($Name,$Library,$Return,$Parameters) {
    $method=$nativeType.DefinePInvokeMethod($Name,$Library,'Public,Static,PinvokeImpl','Standard',$Return,[Type[]]$Parameters,'Winapi','Unicode')
    $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
}
Native-Method CreateFileW kernel32.dll ([IntPtr]) @([string],[uint32],[uint32],[IntPtr],[uint32],[uint32],[IntPtr])
Native-Method CreateDirectoryW kernel32.dll ([bool]) @([string],[IntPtr])
Native-Method CloseHandle kernel32.dll ([bool]) @([IntPtr])
Native-Method GetFileInformationByHandleEx kernel32.dll ([bool]) @([IntPtr],[int],[byte[]],[uint32])
Native-Method GetFileInformationByHandle kernel32.dll ([bool]) @([IntPtr],[byte[]])
Native-Method GetFinalPathNameByHandleW kernel32.dll ([uint32]) @([IntPtr],[Text.StringBuilder],[uint32],[uint32])
Native-Method GetSecurityInfo advapi32.dll ([uint32]) @([IntPtr],[int],[uint32],[IntPtr].MakeByRefType(),[IntPtr].MakeByRefType(),[IntPtr].MakeByRefType(),[IntPtr].MakeByRefType(),[IntPtr].MakeByRefType())
Native-Method GetSecurityDescriptorLength advapi32.dll ([uint32]) @([IntPtr])
Native-Method LocalFree kernel32.dll ([IntPtr]) @([IntPtr])
Native-Method FindFirstStreamW kernel32.dll ([IntPtr]) @([string],[int],[byte[]],[uint32])
Native-Method FindNextStreamW kernel32.dll ([bool]) @([IntPtr],[byte[]])
Native-Method FindClose kernel32.dll ([bool]) @([IntPtr])
$script:SourceNative=$nativeType.CreateType()
$script:SourcePins=New-Object 'Collections.Generic.List[IntPtr]'
function Assert-SourcePath([string]$Value) {
    if ($Value -notmatch '^[A-Za-z]:\\' -or $Value.Length -gt 240 -or $Value.Substring(2) -match '[:/\x00-\x1f<>"|?*]') { throw 'Canonical local path required.' }
    $bad=@($Value.Substring(3).Split('\') | Where-Object { $_ -in @('','.','..') -or $_ -match '[. ]$|^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(\.|$)' })
    if ($bad.Count -gt 0) { throw 'Win32 path alias refused.' }
    $drive=New-Object IO.DriveInfo([IO.Path]::GetPathRoot($Value))
    if ($drive.DriveType -ne 'Fixed' -or $drive.DriveFormat -ne 'NTFS') { throw 'Local fixed NTFS storage required.' }
}
function Native-Security([IntPtr]$Handle) {
    $owner=[IntPtr]::Zero;$group=[IntPtr]::Zero;$dacl=[IntPtr]::Zero;$sacl=[IntPtr]::Zero;$descriptor=[IntPtr]::Zero
    if ($script:SourceNative::GetSecurityInfo($Handle,1,7,[ref]$owner,[ref]$group,[ref]$dacl,[ref]$sacl,[ref]$descriptor) -ne 0) { throw 'Native security unavailable' }
    try {
        $length=$script:SourceNative::GetSecurityDescriptorLength($descriptor)
        if ($length -lt 20 -or $length -gt 65536 -or $dacl -eq [IntPtr]::Zero) { throw 'Unsupported native DACL' }
        $bytes=New-Object byte[] $length;[Runtime.InteropServices.Marshal]::Copy($descriptor,$bytes,0,$length)
        return New-Object Security.AccessControl.RawSecurityDescriptor($bytes,0)
    } finally { [void]$script:SourceNative::LocalFree($descriptor) }
}
function Pin-SourcePath([string]$Value,[switch]$TrustedProgram,[switch]$Private) {
    Assert-SourcePath $Value
    $parts=$Value.Substring(3).Split('\');$current=$Value.Substring(0,3);$last=[IntPtr]::Zero
    $trusted=@('S-1-5-18','S-1-5-32-544')
    if ($TrustedProgram) { $trusted+=([Security.Principal.NTAccount]'NT SERVICE\TrustedInstaller').Translate([Security.Principal.SecurityIdentifier]).Value }
    for ($index=-1;$index -lt $parts.Count;$index++) {
        if ($index -ge 0) { $current=Join-Path $current $parts[$index] }
        $directory=($index -lt $parts.Count-1) -or [IO.Directory]::Exists($current)
        $access=[uint32]0x20080; $sharing=[uint32]3
        if (-not $directory) { $access=[uint32]2147614848; $sharing=[uint32]1 }
        $handle=$script:SourceNative::CreateFileW($current,$access,$sharing,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
        if ($handle -eq [IntPtr](-1)) { throw 'Native no-follow open refused' }
        $script:SourcePins.Add($handle);$last=$handle
        $info=New-Object byte[] 52
        if (-not $script:SourceNative::GetFileInformationByHandle($handle,$info) -or ([BitConverter]::ToUInt32($info,0) -band 0x400) -or (-not $directory -and [BitConverter]::ToUInt32($info,40) -ne 1)) { throw 'Native reparse/hardlink/type refused' }
        $canonical=New-Object Text.StringBuilder 32768
        $length=$script:SourceNative::GetFinalPathNameByHandleW($handle,$canonical,32768,0)
        if ($length -eq 0 -or $length -ge 32768 -or $canonical.ToString().Substring(4).TrimEnd('\') -ine $current.TrimEnd('\')) { throw 'Native path identity changed' }
        if (($TrustedProgram -and $index -ge 0) -or ($Private -and $index -eq $parts.Count-1)) {
            $security=Native-Security $handle
            $owners=$trusted; if ($Private) { $owners=@($taskIdentity.Value,'S-1-5-18','S-1-5-32-544') }
            if ($security.Owner.Value -notin $owners) { throw 'Untrusted native owner' }
            foreach ($ace in $security.DiscretionaryAcl) {
                if ($ace.AceType -ne 'AccessAllowed' -and $ace.AceType -ne 'AccessDenied') { throw 'Unsupported native ACE' }
                if ($ace.AceType -eq 'AccessAllowed' -and -not ($ace.AceFlags -band 8) -and ($Private -or ($ace.AccessMask -band 0x500d0156)) -and $ace.SecurityIdentifier.Value -notin $owners) { throw 'Untrusted native write/access grant' }
            }
        }
    }
    return $last
}
function Close-SourcePins([int]$Keep=0) { while ($script:SourcePins.Count -gt $Keep) { $index=$script:SourcePins.Count-1;[void]$script:SourceNative::CloseHandle($script:SourcePins[$index]);$script:SourcePins.RemoveAt($index) } }
function Assert-StreamInventory([bool]$Succeeded,[byte[]]$Buffer) {
    if (-not $Succeeded) { throw 'Held-handle stream inventory unavailable' }
    $offset=0;$count=0
    do {
        if ($offset -lt 0 -or $offset+24 -gt $Buffer.Length -or ++$count -gt 1024) { throw 'Invalid stream inventory bounds' }
        $next=[BitConverter]::ToUInt32($Buffer,$offset);$length=[BitConverter]::ToUInt32($Buffer,$offset+4)
        if ($length -eq 0 -or $length%2 -ne 0 -or $length -gt 592 -or $offset+24+$length -gt $Buffer.Length) { throw 'Invalid stream name length' }
        $name=[Text.Encoding]::Unicode.GetString($Buffer,$offset+24,$length)
        if ($name -cne '::$DATA' -or $count -ne 1) { throw 'Alternate data stream refused' }
        if ($next -eq 0) { break }
        if ($next -lt 24+$length -or $next%8 -ne 0) { throw 'Invalid stream inventory chain' }
        $offset+=$next
    } while ($true)
}
function No-AlternateStreams([string]$Value) {
    $keep=$script:SourcePins.Count
    try {
        $handle=Pin-SourcePath $Value
        $buffer=New-Object byte[] 65536
        $ok=$script:SourceNative::GetFileInformationByHandleEx($handle,7,$buffer,$buffer.Length)
        Assert-StreamInventory $ok $buffer
    } finally { Close-SourcePins $keep }
}
function Flush-SourceFile([string]$Value) { $stream=[IO.File]::Open($Value,'Open','ReadWrite','Read');try{$stream.Flush($true)}finally{$stream.Dispose()} }
