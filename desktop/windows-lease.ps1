$ErrorActionPreference = 'Stop'
# A product-specific OS lease, not a process-name heuristic. Never stop a process.
$created = $false
$lease = [System.Threading.Mutex]::new($true, 'Global\abysSUS-package-maintenance-v1', [ref]$created)
if (-not $created) { $lease.Dispose(); exit 73 }
try {
  [Console]::Out.WriteLine('ready')
  [Console]::Out.Flush()
  [Console]::In.ReadToEnd() | Out-Null
} finally { $lease.ReleaseMutex(); $lease.Dispose() }
