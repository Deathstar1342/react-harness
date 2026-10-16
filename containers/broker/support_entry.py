"""Fixed bundled entry. Constrain DLL resolution before loading broker modules."""
import ctypes
import os
from pathlib import Path
import runpy
import sys

def confine_dll_search():
    if os.name=='nt':
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.SetDefaultDllDirectories.argtypes=[ctypes.c_ulong];kernel.SetDefaultDllDirectories.restype=ctypes.c_int
        if not kernel.SetDefaultDllDirectories(0x00000800|0x00000200|0x00000400):
            raise RuntimeError('Windows DLL search confinement unavailable')

if __name__=='__main__':
    confine_dll_search()
    modes={(): 'desktop_host.py',('engine-query',):'engine_query.py',('retained-supervisor',):'retained_supervisor.py'}
    target=modes.get(tuple(sys.argv[1:]))
    if target is None:raise SystemExit(1)
    runpy.run_path(str(Path(__file__).resolve().with_name(target)),run_name='__main__')
