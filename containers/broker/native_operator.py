"""Host-only, authenticated operator transport for a retained Windows supervisor.

This module neither starts Docker nor accepts generic commands. Its capability,
lease and journal reside outside every container mount. No PID grants authority.
"""
import contextlib
import hmac
import json
from pathlib import Path
import re
import secrets
import socket
import socketserver
import sqlite3
import threading
import time
import uuid
from protocol import require,exact,decode,canonical,mac,digest,HEX,UUID,Denied,now
from transfer_service import private_json,write_new
from storage_proof import validate_native

PROTOCOL='abyssus-native-operator-v1'
LIMIT=16384
BINDING=('storageId','engineId','context','controllerImage','workerImage','sourceDigest','runtimeDigest','launchId')
OPS=('status','stopped','transfer-select','transfer-authorize','transfer-discard','drain')


def validate_binding(value):
    exact(value,BINDING)
    for key in ('storageId','launchId'):require(type(value[key]) is str and UUID.fullmatch(value[key]),'INVALID_OPERATOR_BINDING')
    for key in ('sourceDigest','runtimeDigest'):require(type(value[key]) is str and HEX.fullmatch(value[key]),'INVALID_OPERATOR_BINDING')
    for key in ('controllerImage','workerImage'):require(type(value[key]) is str and re.fullmatch('sha256:[a-f0-9]{64}',value[key]),'INVALID_OPERATOR_BINDING')
    require(type(value['engineId']) is str and re.fullmatch('[!-~]{1,256}',value['engineId']),'INVALID_OPERATOR_BINDING')
    require(type(value['context']) is str and re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}',value['context']),'INVALID_OPERATOR_BINDING')


def validate_request(request):
    require(type(request) is dict and request.get('op') in OPS,'OPERATOR_OPERATION_REFUSED')
    op=request['op']
    if op in ('status','stopped','drain'):exact(request,['op'])
    elif op in ('transfer-authorize','transfer-discard'):
        exact(request,['op','handle']);require(type(request['handle']) is str and HEX.fullmatch(request['handle']),'INVALID_SELECTION')
    else:
        exact(request,['op','kind','path','project','included','history'])
        require(request['kind'] in ('import','export') and type(request['path']) is str and 0<len(request['path'])<=4096 and not any(ord(c)<32 for c in request['path']),'INVALID_SELECTION')
        require(request['project'] is None if request['kind']=='import' else type(request['project']) is str and UUID.fullmatch(request['project']),'INVALID_SELECTION')
        require(type(request['included']) is list and len(request['included'])<=100 and all(type(v) is str and 0<len(v)<=240 for v in request['included']) and type(request['history']) is bool,'INVALID_SELECTION')


def validate_record(value):
    exact(value,['version','binding','native','instanceId','sessionId','key','host','port','phase'])
    require(type(value['version']) is int and value['version']==1,'OPERATOR_RECORD_CHANGED');validate_binding(value['binding']);validate_native(value['native'])
    require(all(type(value[k]) is str and UUID.fullmatch(value[k]) for k in ('instanceId','sessionId')),'OPERATOR_RECORD_CHANGED')
    require(type(value['key']) is str and HEX.fullmatch(value['key']) and value['host']=='127.0.0.1','OPERATOR_RECORD_CHANGED')
    require(value['phase'] in ('intent','active','draining','drained','uncertain'),'OPERATOR_RECORD_CHANGED')
    require(value['port'] is None if value['phase']=='intent' else type(value['port']) is int and 1024<=value['port']<=65535,'OPERATOR_RECORD_CHANGED')


class LocalServer(socketserver.ThreadingTCPServer):
    daemon_threads=True
    allow_reuse_address=False
    request_queue_size=8
    def __init__(self,*args,**kwargs):
        self.admission=threading.BoundedSemaphore(8);super().__init__(*args,**kwargs)
    def process_request(self,request,address):
        if not self.admission.acquire(blocking=False):self.shutdown_request(request);return
        try:super().process_request(request,address)
        except BaseException:self.admission.release();raise
    def process_request_thread(self,request,address):
        try:super().process_request_thread(request,address)
        finally:self.admission.release()
    def handle_error(self,*_):pass


def read_record(area):
    from windows_handles import operator_record_lock
    with operator_record_lock(area):
        require(not (Path(area).parent.parent/'.native-operator-intent.json').exists(),'OPERATOR_PARTIAL_PUBLICATION')
        return private_json(Path(area)/'current.json',LIMIT)


class NativeOperator:
    def __init__(self,storage,binding,guard,dispatch):
        from windows_handles import PinnedPath,exclusive_lock
        validate_binding(binding);self.guard=guard;native=guard.verify();self.binding=dict(binding);self.dispatch=dispatch
        self.stack=contextlib.ExitStack();self.lock=threading.RLock();self.server=None;self.db=None;self.closed=False;self.failure=None
        self.area=Path(storage)/'runtime/operator';self.area.mkdir(exist_ok=True)
        self.file=self.area/'current.json'
        try:
            self.stack.enter_context(PinnedPath(self.area,directory=True)).private()
            self.published=None
            self.stack.enter_context(exclusive_lock(self.area/'lifetime.lock'))
            if self.file.exists():
                previous=read_record(self.area);validate_record(previous);self.published=previous
                require(previous['native']==native and previous['binding']['storageId']==binding['storageId'] and previous['phase']=='drained','OPERATOR_RECOVERY_REQUIRED')
            else:
                require(set(p.name for p in self.area.iterdir())=={'lifetime.lock'},'OPERATOR_PARTIAL_JOURNAL')
                with exclusive_lock(self.area/'record.lock'):pass
            require(not any(Path(storage).glob('.native-operator-*.pending')) and not (Path(storage)/'.native-operator-intent.json').exists(),'OPERATOR_PARTIAL_PUBLICATION')
            self.record={'version':1,'binding':self.binding,'native':native,'instanceId':str(uuid.uuid4()),'sessionId':str(uuid.uuid4()),'key':secrets.token_hex(32),'host':'127.0.0.1','port':None,'phase':'intent'}
            self.save()
            # A private per-instance journal retains request consumption after loss.
            database=self.area/(self.record['instanceId']+'.sqlite')
            with PinnedPath(database,write=True,create=True,directory=False) as pin:pin.private()
            from windows_handles import operator_record_lock
            with operator_record_lock(self.area):
                self.db=sqlite3.connect(str(database),check_same_thread=False);self.db.execute('PRAGMA synchronous=FULL');self.db.execute('CREATE TABLE requests(nonce TEXT PRIMARY KEY,state TEXT NOT NULL)');self.db.commit()
            self.server=LocalServer(('127.0.0.1',0),self.handler())
        except BaseException:
            if self.server:self.server.server_close()
            if self.db:self.db.close()
            self.stack.close();raise
    def activate(self):
        with self.lock:
            require(self.record['phase']=='intent','OPERATOR_ALREADY_ACTIVATED')
            self.record.update(port=self.server.server_address[1],phase='active');self.save()
    def save(self):
        from windows_handles import rename_handle,operator_record_lock,remove_owned_record,PinnedPath
        import copy
        self.guard.verify()
        # Intent and staging are private root children, outside every mount and
        # the descendant iterator; interruption prevents another start.
        root=self.area.parent.parent;temporary=root/('.native-operator-'+str(uuid.uuid4())+'.pending');intent=root/'.native-operator-intent.json'
        value={'version':1,'instanceId':self.record['instanceId'],'stage':temporary.name,'before':digest(self.published) if self.published else None,'after':digest(self.record)}
        with operator_record_lock(self.area):
            require(private_json(self.file,LIMIT)==self.published if self.published else not self.file.exists(),'OPERATOR_OWNER_CHANGED')
            write_new(intent,value);write_new(temporary,self.record)
            with PinnedPath(temporary,directory=False) as pin:pin.private()
            rename_handle(temporary,self.file,replace=True)
            require(private_json(self.file,LIMIT)==self.record,'OPERATOR_PUBLICATION_CHANGED')
            remove_owned_record(intent,value);self.published=copy.deepcopy(self.record)
    def fresh(self):
        require(not self.closed and not self.failure and self.record['phase']=='active','OPERATOR_REVOKED')
        try:
            require(self.guard.verify()==self.record['native'],'OPERATOR_STORAGE_CHANGED')
            require(read_record(self.area)==self.record,'OPERATOR_OWNER_CHANGED')
        except BaseException:
            self.failure=True
            # Never overwrite a changed owner's record or write through lost ACL
            # authority. In-memory revocation is unconditional and monotonic.
            try:
                if self.guard.verify()==self.record['native'] and read_record(self.area)==self.record:
                    self.record['phase']='uncertain';self.save()
            except Exception:pass
            raise
    def handle(self,envelope):
        with self.lock:
            self.fresh();exact(envelope,['protocol','instanceId','sessionId','binding','nonce','expiresAt','request','mac'])
            require(envelope['protocol']==PROTOCOL and envelope['instanceId']==self.record['instanceId'] and envelope['sessionId']==self.record['sessionId'] and envelope['binding']==digest(self.binding),'OPERATOR_OWNER_CHANGED')
            require(type(envelope['nonce']) is str and HEX.fullmatch(envelope['nonce']) and type(envelope['mac']) is str and HEX.fullmatch(envelope['mac']),'OPERATOR_AUTH_FAILED')
            require(type(envelope['expiresAt']) is int and now()<envelope['expiresAt']<=now()+30000,'OPERATOR_EXPIRED')
            unsigned={k:v for k,v in envelope.items() if k!='mac'}
            require(hmac.compare_digest(mac(unsigned,self.record['key']),envelope['mac']),'OPERATOR_AUTH_FAILED')
            validate_request(envelope['request']);nonce=envelope['nonce'];request=envelope['request']
            from windows_handles import operator_record_lock
            with operator_record_lock(self.area),self.db:
                require(self.db.execute('SELECT count(*) FROM requests').fetchone()[0]<20000,'OPERATOR_CAPACITY')
                self.db.execute('INSERT INTO requests VALUES (?,?)',(nonce,'intent'))
            self.fresh()
            if request['op']=='drain':self.record['phase']='draining';self.save()
            try:
                result=self.dispatch(request)
                if request['op']=='drain':require(result=={'stopped':True},'OPERATOR_DRAIN_UNVERIFIED')
                require(len(canonical(result).encode())<=LIMIT//2,'OPERATOR_REPLY_LIMIT')
                self.guard.verify()
                with operator_record_lock(self.area),self.db:self.db.execute('UPDATE requests SET state=? WHERE nonce=?',('complete',nonce))
                return result
            except BaseException:
                with operator_record_lock(self.area),self.db:self.db.execute('UPDATE requests SET state=? WHERE nonce=?',('uncertain',nonce))
                if request['op']=='drain':self.record['phase']='uncertain';self.save()
                raise
    def handler(self):
        authority=self
        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                self.request.settimeout(5);envelope=None;drained=False
                try:
                    raw=self.rfile.readline(LIMIT+1);require(len(raw)<=LIMIT,'OPERATOR_WIRE_LIMIT');envelope=decode(raw)
                    result=authority.handle(envelope);drained=envelope['request']['op']=='drain'
                    reply={'protocol':PROTOCOL,'instanceId':authority.record['instanceId'],'sessionId':authority.record['sessionId'],'nonce':envelope['nonce'],'ok':True,'result':result}
                except Exception as error:
                    if type(envelope) is not dict or type(envelope.get('nonce')) is not str or not HEX.fullmatch(envelope['nonce']):return
                    code=str(error) if isinstance(error,Denied) and re.fullmatch('[A-Z_]{1,64}',str(error)) else 'OPERATOR_UNCERTAIN'
                    reply={'protocol':PROTOCOL,'instanceId':authority.record['instanceId'],'sessionId':authority.record['sessionId'],'nonce':envelope['nonce'],'ok':False,'error':code}
                try:self.wfile.write((canonical({**reply,'mac':mac(reply,authority.record['key'])})+'\n').encode());self.wfile.flush()
                finally:
                    if drained:threading.Thread(target=authority.server.shutdown,daemon=True).start()
        return Handler
    def serve(self):
        self.fresh()
        try:self.server.serve_forever(poll_interval=.05)
        finally:
            self.server.server_close()
            with self.lock:
                if self.record['phase']=='draining':self.record['phase']='drained';self.save()
                self.closed=True
                from windows_handles import operator_record_lock
                with operator_record_lock(self.area):self.db.close()
                self.stack.close()


def descriptor(storage,binding,guard):
    validate_binding(binding);record=read_record(Path(storage)/'runtime/operator');validate_record(record)
    require(record['binding']==binding and record['native']==guard.verify() and record['phase']=='active','OPERATOR_OWNER_CHANGED')
    return record


def request(record,body,timeout=40):
    validate_record(record);validate_request(body);require(record['phase']=='active','OPERATOR_REVOKED')
    unsigned={'protocol':PROTOCOL,'instanceId':record['instanceId'],'sessionId':record['sessionId'],'binding':digest(record['binding']),'nonce':secrets.token_hex(32),'expiresAt':now()+30000,'request':body}
    wire=(canonical({**unsigned,'mac':mac(unsigned,record['key'])})+'\n').encode();require(len(wire)<=LIMIT,'OPERATOR_WIRE_LIMIT')
    with socket.create_connection((record['host'],record['port']),timeout=timeout) as peer:
        peer.settimeout(timeout);peer.sendall(wire)
        with peer.makefile('rb') as stream:raw=stream.readline(LIMIT+1)
    require(len(raw)<=LIMIT,'OPERATOR_WIRE_LIMIT');reply=decode(raw)
    exact(reply,['protocol','instanceId','sessionId','nonce','ok','result' if reply.get('ok') is True else 'error','mac'])
    require(reply['protocol']==PROTOCOL and reply['instanceId']==record['instanceId'] and reply['sessionId']==record['sessionId'] and reply['nonce']==unsigned['nonce'] and type(reply['ok']) is bool and type(reply['mac']) is str,'OPERATOR_REPLY_CHANGED')
    value={k:v for k,v in reply.items() if k!='mac'};require(hmac.compare_digest(mac(value,record['key']),reply['mac']),'OPERATOR_AUTH_FAILED')
    require(reply['ok'],'OPERATOR_REQUEST_REFUSED');return reply['result']


def wait_drained(storage,record,guard,timeout=20):
    """Reply is not cleanup evidence: exact durable receipt, lease and endpoint."""
    from windows_handles import exclusive_lock
    validate_record(record);area=Path(storage)/'runtime/operator';end=time.monotonic()+timeout
    while True:
        require(guard.verify()==record['native'],'OPERATOR_STORAGE_CHANGED')
        current=read_record(area);validate_record(current)
        require(all(current[key]==value for key,value in record.items() if key!='phase'),'OPERATOR_OWNER_CHANGED')
        require(current['phase'] in ('draining','drained'),'OPERATOR_DRAIN_UNCERTAIN')
        if current['phase']=='drained':
            try:
                with exclusive_lock(area/'lifetime.lock'):
                    require(read_record(area)==current,'OPERATOR_OWNER_CHANGED')
                    try:
                        with socket.create_connection((record['host'],record['port']),timeout=3):pass
                    except ConnectionRefusedError:return {'stopped':True}
                    raise Denied('OPERATOR_ENDPOINT_RETAINED')
            except BlockingIOError:pass
        require(time.monotonic()<end,'OPERATOR_DRAIN_UNCERTAIN');time.sleep(.05)
