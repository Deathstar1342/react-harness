"""Fixed bundled entry. Constrain DLL resolution before loading broker modules."""
import ctypes
import os
from pathlib import Path
import runpy

def confine_dll_search():
    if os.name=='nt':
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.SetDefaultDllDirectories.argtypes=[ctypes.c_ulong];kernel.SetDefaultDllDirectories.restype=ctypes.c_int
        if not kernel.SetDefaultDllDirectories(0x00000800|0x00000200|0x00000400):
            raise RuntimeError('Windows DLL search confinement unavailable')

if __name__=='__main__':
    confine_dll_search()
    runpy.run_path(str(Path(__file__).resolve().with_name('desktop_host.py')),run_name='__main__')
