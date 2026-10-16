"""Disposable native-process transport fixture; no Docker or user project access."""
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'containers/broker'))
from protocol import canonical
launch=json.loads(sys.stdin.readline())
if sys.argv[1]=='parent':
    env={key:os.environ[key] for key in ('SystemRoot','WINDIR','TEMP','TMP') if key in os.environ}
    child=subprocess.Popen([sys.executable,'-I','-B',__file__,'host'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,creationflags=subprocess.CREATE_NO_WINDOW|subprocess.CREATE_NEW_PROCESS_GROUP)
    child.stdin.write(canonical(launch)+'\n');child.stdin.flush();child.stdin.close()
    print(child.stdout.readline().strip(),flush=True)
    sys.stdin.read() # Test kills this exact fixture parent after ready.
    raise SystemExit(0)
from windows_handles import NativeStorageGuard
from native_operator import NativeOperator
import native_operator
storage=Path(launch['storage']);guard=NativeStorageGuard(storage)
def dispatch(request):
    op=request['op']
    if op=='status':return {'fixture':True,'alive':True}
    if op=='stopped':return {'stopped':True}
    if op=='drain':return {'stopped':not launch.get('failDrain',False)}
    if op=='transfer-discard':
        with (storage/'runtime/operator/fixture-effects').open('ab') as effect:effect.write(b'x');effect.flush();os.fsync(effect.fileno())
        return {'discarded':True}
    raise RuntimeError('FIXTURE_REFUSAL')
try:
    if launch.get('publicationFault'):
        original_write=native_operator.write_new
        def write(file,value):
            if launch['publicationFault']=='stage' and file.name.startswith('.native-operator-') and file.name.endswith('.pending'):raise OSError('FIXTURE_LOST_STAGE')
            return original_write(file,value)
        native_operator.write_new=write
        if launch['publicationFault']=='receipt':
            import windows_handles
            def lost_receipt(*_):raise OSError('FIXTURE_LOST_PUBLICATION_RECEIPT')
            windows_handles.remove_owned_record=lost_receipt
    operator=NativeOperator(storage,launch['binding'],guard,dispatch)
    operator.activate()
    # Bounded test-only process cleanup. This is never part of production host.
    def expire():
        with operator.lock:operator.record['phase']='uncertain';operator.save()
        operator.server.shutdown()
    timer=threading.Timer(25,expire);timer.daemon=True;timer.start()
    print(canonical({'ready':True}),flush=True)
    try:operator.serve()
    finally:timer.cancel()
except Exception as error:
    import traceback
    (storage/('runtime/fixture-native-failure-'+str(os.getpid())+'.json')).write_text(canonical({'type':type(error).__name__,'code':str(error),'frames':[[Path(frame.filename).name,frame.lineno,frame.name] for frame in traceback.extract_tb(error.__traceback__)]}))
    print(canonical({'failure':type(error).__name__}),flush=True);raise SystemExit(2)
finally:guard.close()
