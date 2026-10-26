"""Fixed owned-worker HTTP reads, never arbitrary sockets or Docker requests.

All durable authorization/ownership belongs to the existing process claim. Buffers
are ephemeral observations, expire without adoption, and cannot grant execution.
"""
import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import threading
import time
import uuid
from protocol import require, exact, claim_identity, HEX, UUID, canonical, decode, Denied

_helper_spec = importlib.util.spec_from_file_location('_abyssus_preview_http', Path(__file__).parent.parent/'preview-http.py')
_helper = importlib.util.module_from_spec(_helper_spec)
_helper_spec.loader.exec_module(_helper)
PAGE = 32768
MAX_BODY = 4*1024*1024
MAX_REPLY = 6*1024*1024

class Previews:
    def __init__(self, broker):
        self.broker = broker
        self.live = {}
        self.buffers = {}

    def owned(self, body):
        token = {key:body.get(key) for key in ('claimId','binding')}
        claim_identity(token)
        record = self.broker.journal.owned(token)
        require(not self.broker.closing and record['state']=='running', 'PREVIEW_STALE')
        owned = self.broker.docker.contexts.get(record['contextId'])
        require(owned and owned['project']==record['project'] and owned['identity']==record['identity'], 'PREVIEW_WORKER_CHANGED')
        port = record['operation'].get('previewPort')
        require(record['operation']['kind']=='shell' and type(port) is int and 1024<=port<=65535 and port!=3128, 'PREVIEW_PORT_REFUSED')
        self.broker.docker.preview_verify(owned)
        return record, owned, port

    def prune(self):
        current=time.monotonic()
        for key,row in list(self.buffers.items()):
            if current>row['expires']:del self.buffers[key]

    def invalidate(self, context=None):
        # Called under the broker lock before exact worker removal or shutdown.
        for key,row in list(self.buffers.items()):
            if context is None or row['context']==context:del self.buffers[key]
        for entry in self.live.values():
            if context is None or entry['context']==context:
                entry['cancelled']=True
                process=entry.get('process')
                if process is not None and process.poll() is None:process.kill()  # exact owned CLI only

    def dispatch(self, op, body):
        require(op in ('preview_open','preview_read','preview_close'), 'UNKNOWN_OPERATION')
        fields=['claimId','binding','path'] if op=='preview_open' else ['claimId','binding','handle']+(['offset'] if op=='preview_read' else [])
        exact(body,fields)
        with self.broker.lock:
            self.prune()
            record,owned,port=self.owned(body)
            if op!='preview_open':
                handle=body['handle'];require(type(handle) is str and UUID.fullmatch(handle),'PREVIEW_HANDLE_REFUSED')
                row=self.buffers.get(handle)
                require(row and row['claimId']==record['claimId'] and row['binding']==record['binding'] and row['context']==record['contextId'],'PREVIEW_STALE')
                if op=='preview_close':
                    del self.buffers[handle]
                    return {'handle':handle,'closed':True}
                offset=body['offset'];require(type(offset) is int and offset==row['offset'],'PREVIEW_CURSOR_REFUSED')
                data=row['body'][offset:offset+PAGE];row['offset']+=len(data)
                return {'handle':handle,'offset':offset,'nextOffset':row['offset'],'totalBytes':len(row['body']),'data':base64.b64encode(data).decode('ascii')}
            target=_helper.request_target(body['path'])
            require(len(self.live)<4 and sum(row['context']==record['contextId'] for row in self.live.values())<2,'PREVIEW_BUSY')
            # Reserve response capacity before the network await. Buffers never evict evidence/claims.
            require(len(self.buffers)+len(self.live)<8,'PREVIEW_BUFFER_LIMIT')
            key=str(uuid.uuid4());entry={'context':record['contextId'],'cancelled':False,'process':None};self.live[key]=entry
            args=['exec','-i','--user','0:0',owned['container'],'/usr/bin/env','-i','PATH=/usr/bin:/bin','/usr/bin/python3','-I','/opt/abyssus-worker/preview-http.py']
            process=None
            try:
                self.broker.docker.storage_barrier()
                process=subprocess.Popen(self.broker.docker.argv(args),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=self.broker.docker.env,**self.broker.docker.process_options())
                entry['process']=process
            except BaseException:
                self.live.pop(key,None)
                raise
        # Never hold global broker lock while a project server withholds a reply.
        watchdog=threading.Timer(17,process.kill);watchdog.daemon=True;watchdog.start()
        errors=[]
        def stderr():
            try:
                require(len(process.stderr.read(4097))<=4096,'PREVIEW_STDERR_LIMIT')
            except BaseException:
                errors.append(True)
                if process.poll() is None:process.kill()
        thread=threading.Thread(target=stderr,daemon=True);thread.start()
        try:
            payload=(canonical({'port':port,'path':target})+'\n').encode('ascii')
            require(len(payload)<=4096,'PREVIEW_INPUT_LIMIT')
            process.stdin.write(payload);process.stdin.close()
            raw=process.stdout.read(MAX_REPLY+1)
            require(len(raw)<=MAX_REPLY,'PREVIEW_BODY_LIMIT')
            require(process.wait(timeout=2)==0,'PREVIEW_FETCH_FAILED')
            thread.join(timeout=2);require(not thread.is_alive() and not errors,'PREVIEW_STDERR_LIMIT')
            # This bounded helper reply may exceed the worker envelope, but never travels on it.
            require(raw.endswith(b'\n') and b'\n' not in raw[:-1], 'PREVIEW_REPLY_REFUSED')
            def pairs(items):
                value={}
                for name,item in items:
                    require(name not in value,'PREVIEW_REPLY_REFUSED');value[name]=item
                return value
            result=json.loads(raw.decode('ascii'),object_pairs_hook=pairs)
            exact(result,['status','contentType','body'])
            require(type(result['status']) is int and 200<=result['status']<=599 and not 300<=result['status']<=399,'PREVIEW_STATUS_REFUSED')
            require(type(result['contentType']) is str and result['contentType'].split(';')[0] in _helper.TYPES,'PREVIEW_TYPE_REFUSED')
            require(type(result['body']) is str,'PREVIEW_BODY_REFUSED')
            data=base64.b64decode(result['body'],validate=True)
            require(len(data)<=MAX_BODY and base64.b64encode(data).decode('ascii')==result['body'],'PREVIEW_BODY_LIMIT')
            with self.broker.lock:
                current,current_owned,_=self.owned(body)
                require(not entry['cancelled'] and current_owned['container']==owned['container'] and current['identity']==record['identity'],'PREVIEW_STALE')
                self.buffers[key]={'claimId':record['claimId'],'binding':record['binding'],'context':record['contextId'],'body':data,'offset':0,'expires':time.monotonic()+20}
                return {'handle':key,'status':result['status'],'contentType':result['contentType'],'totalBytes':len(data)}
        finally:
            watchdog.cancel()
            if process.poll() is None:process.kill()
            try:process.wait(timeout=2)
            finally:
                for stream in (process.stdout,process.stderr):stream.close()
                thread.join(timeout=2)
                with self.broker.lock:self.live.pop(key,None)
