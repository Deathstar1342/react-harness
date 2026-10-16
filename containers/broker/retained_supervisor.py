"""Fixed hidden retained-supervisor entry; bootstrap arrives only on private stdin."""
import os
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from protocol import decode,require,canonical,Denied
from windows_supervisor import WindowsSupervisor

def main():
    raw=sys.stdin.buffer.readline(16385);require(len(raw)<=16384 and raw.endswith(b'\n'),'NATIVE_LAUNCH_LIMIT');launch=decode(raw)
    host=WindowsSupervisor(launch,Path(__file__).resolve().parents[2])
    try:
        ready=host.start();print(canonical({'ready':ready}),flush=True)
        # Detached ownership never relies on the parent's still-open pipe handles.
        sys.stdout=open(os.devnull,'w');sys.stderr=open(os.devnull,'w')
        host.serve()
    finally:host.close_handles()

if __name__=='__main__':
    try:main()
    except Exception as error:
        import re
        code=str(error) if isinstance(error,Denied) and re.fullmatch('[A-Z_]{1,64}',str(error)) else 'NATIVE_SUPERVISION_UNCERTAIN'
        try:print(canonical({'error':code}),flush=True)
        except Exception:pass
        raise SystemExit(1)
