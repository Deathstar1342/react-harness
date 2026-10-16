"""Fixed bundled entry. Constrain DLL resolution before loading broker modules."""
import ctypes
import os
from pathlib import Path
import runpy
if os.name=='nt':
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    if not kernel.SetDefaultDllDirectories(0x00000800|0x00000200|0x00000400):
        raise RuntimeError('Windows DLL search confinement unavailable')
runpy.run_path(str(Path(__file__).resolve().with_name('desktop_host.py')),run_name='__main__')
