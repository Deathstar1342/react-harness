"""Private parent-pipe adapter; reconnect authenticates the retained native owner."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
from protocol import require,canonical,exact
from native_payload import NativePayload
from native_operator import read_record,descriptor,request,wait_drained,validate_record
from windows_handles import NativeStorageGuard
from windows_supervisor import validate_launch

class WindowsDesktopHost:
    def __init__(self,launch):
        validate_launch(launch);self.launch=dict(launch);self.storage=Path(launch['storage']);self.source=Path(__file__).resolve().parents[2]
        self.payload=NativePayload(self.source,launch['runtimeDigest']);self.guard=None;self.record=None;self.child=None;self.owner=None
        self.binding={key:launch[key] for key in ('storageId','engineId','context','controllerImage','workerImage','runtimeDigest','launchId')};self.binding['sourceDigest']=self.payload.source_digest
    def start(self):
        file=self.storage/'runtime/operator/current.json'
        if self.launch['mode']=='existing' and file.exists():
            retained=read_record(file.parent);validate_record(retained)
            require(retained['phase'] in ('active','drained'),'NATIVE_RECONNECT_UNCERTAIN')
            if retained['phase']=='active':
                require(all(retained['binding'][key]==value for key,value in self.binding.items() if key!='launchId'),'NATIVE_RECONNECT_BINDING_CHANGED')
                self.binding=retained['binding'];self.guard=NativeStorageGuard(self.storage);self.record=descriptor(self.storage,self.binding,self.guard)
                return request(self.record,{'op':'status'})
            # A new lifecycle follows only a proved prior drain, never stale PID/port.
            require(all(retained['binding'][key]==self.binding[key] for key in ('storageId','engineId','context')),'NATIVE_RECONNECT_BINDING_CHANGED')
            self.guard=NativeStorageGuard(self.storage);wait_drained(self.storage,retained,self.guard);self.guard.close();self.guard=None
        env={key:os.environ[key] for key in ('SystemRoot','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP') if key in os.environ}
        self.child=subprocess.Popen([sys.executable,'-I','-B',str(self.source/'containers/broker/support_entry.py'),'retained-supervisor'],cwd=str(Path(sys.executable).parent),env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,creationflags=subprocess.CREATE_NO_WINDOW|subprocess.CREATE_NEW_PROCESS_GROUP)
        self.child.stdin.write(canonical(self.launch)+'\n');self.child.stdin.flush();self.child.stdin.close()
        output=queue.Queue()
        def read():
            try:output.put(self.child.stdout.readline(16385))
            except BaseException:output.put('')
        threading.Thread(target=read,daemon=True).start();raw=output.get(timeout=240)
        require(raw.endswith('\n') and len(raw)<=16384,'NATIVE_STARTUP_UNCERTAIN');value=json.loads(raw);exact(value,['ready'])
        self.guard=NativeStorageGuard(self.storage);self.record=descriptor(self.storage,self.binding,self.guard)
        observed=request(self.record,{'op':'status'});require({**observed,'reconnect':False}==value['ready'],'NATIVE_READY_CHANGED')
        self.child.stdout.close();self.child.stderr.close();return value['ready']
    def dispatch(self,body):
        require(self.record is not None and self.guard is not None,'NATIVE_OWNER_UNAVAILABLE')
        # Re-read exact bound current authority before every parent operation.
        require(descriptor(self.storage,self.binding,self.guard)==self.record,'NATIVE_OWNER_CHANGED')
        result=request(self.record,body,timeout=400 if body.get('op')=='drain' else 120)
        if body.get('op')=='drain':
            require(result=={'stopped':True},'NATIVE_DRAIN_UNCERTAIN');result=wait_drained(self.storage,self.record,self.guard)
            if self.child:require(self.child.wait(timeout=20)==0,'NATIVE_PROCESS_EXIT_UNCERTAIN')
        return result
    def close(self):
        if self.guard:self.guard.close()
        self.payload.close()
