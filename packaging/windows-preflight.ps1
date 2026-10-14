param([Parameter(Mandatory=$true)][string]$DataFolder, [Parameter(Mandatory=$true)][string]$InstallFolder, [string]$PreviousFolder = '')
$ErrorActionPreference = 'Stop'
try {
  if ($args.Count -ne 0) { throw 'Unexpected arguments' }
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CanonicalFolder {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string p, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle h, StringBuilder b, uint size, uint flags);
  public static string Read(string p) {
    using (var h=CreateFile(p, 0x80, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if(h.IsInvalid) throw new Exception("Folder unavailable");
      var b=new StringBuilder(32768); uint n=GetFinalPathNameByHandle(h,b,32768,0);
      if(n==0 || n>=32768) throw new Exception("Folder unavailable");
      string result=b.ToString();
      if(!result.StartsWith(@"\\?\") || result.StartsWith(@"\\?\UNC\")) throw new Exception("Local drive required");
      return result.Substring(4);
    }
  }
}
'@
  function Canonical([string]$value) {
    if ($value.TrimEnd('\','/').Length -le 2) { throw 'Drive root is not a data folder' }
    if ($value.Length -gt 240 -or $value -notmatch '^[A-Za-z]:\\' -or $value.Substring(2) -match '[\x00-\x1f<>:"|?*]' -or ($value -split '[\\/]' | Where-Object { $_ -in '.', '..' -or $_ -match '[. ]$' })) { throw 'Invalid local folder' }
    $candidate = [IO.Path]::GetFullPath($value).TrimEnd('\')
    $suffix = [Collections.Generic.List[string]]::new()
    while (-not (Test-Path -LiteralPath $candidate)) {
      $suffix.Insert(0, [IO.Path]::GetFileName($candidate))
      $candidate = [IO.Path]::GetDirectoryName($candidate)
      if (-not $candidate) { throw 'Unavailable drive' }
    }
    $result = [CanonicalFolder]::Read($candidate).TrimEnd('\')
    foreach ($part in $suffix) { $result = Join-Path $result $part }
    if ($result.Length -lt 4) { throw 'Drive root is not a data folder' }
    return $result
  }
  function Overlap([string]$a, [string]$b) { return $a.Equals($b,[StringComparison]::OrdinalIgnoreCase) -or $a.StartsWith($b+'\',[StringComparison]::OrdinalIgnoreCase) -or $b.StartsWith($a+'\',[StringComparison]::OrdinalIgnoreCase) }
  $data = Canonical $DataFolder
  $install = Canonical $InstallFolder
  foreach ($protected in @($install,$env:SystemRoot,$env:ProgramFiles,${env:ProgramFiles(x86)})) {
    if ($protected -and (Overlap $data (Canonical $protected))) { throw 'Data overlaps protected application or OS files' }
  }
  if ($PreviousFolder) {
    if (-not (Test-Path -LiteralPath $PreviousFolder -PathType Container) -or -not $data.Equals((Canonical $PreviousFolder),[StringComparison]::OrdinalIgnoreCase)) { throw 'Saved data location changed or unavailable' }
  }
  if ((Test-Path -LiteralPath $InstallFolder) -and @(Get-ChildItem -LiteralPath $InstallFolder -Force).Count -ne 0) { throw 'Application folder must be empty; uninstall or inspect interrupted setup first' }
  New-Item -ItemType Directory -Path $data -Force | Out-Null
  $probe = Join-Path $data ('.abyssus-probe-' + [Guid]::NewGuid().ToString('N'))
  $stream = [IO.File]::Open($probe,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  $stream.Dispose()
  Remove-Item -LiteralPath $probe
  exit 0
} catch {
  Write-Output 'Choose an empty application folder and a separate writable local data folder. Roots, protected folders, linked aliases and unavailable saved locations are rejected. Restore the saved drive or inspect interrupted setup; no data migration occurred.'
  exit 76
}
