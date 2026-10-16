"""Trusted native initializer/controller phase activation on one held TCP socket."""
import hashlib
from pathlib import Path
import secrets
import threading
import uuid
from protocol import Journal,PROTOCOL,canonical,require,UUID
from native_session import NativeSession
from storage_proof import StorageProofs
from storage_probe import FixedStorageProbe
from route_probe import prove_server,verify_route
from transfer_service import write_new
from windows_handles import PinnedPath,rename_handle

class NativePhase:
    def __init__(self,docker,launch,guard):
        self.docker=docker;self.launch=launch;self.guard=guard;self.server=None;self.thread=None;self.session=None;self.journal=None;self.failed=False
        self.binding={key:launch[key] for key in ('storageId','launchId','context','engineId','controllerImage')};self.binding['probeImage']=launch['controllerImage']
    def publish(self,name,value):
        require(not self.failed and self.thread is None and name in ('native-bind.json','session.json','desktop-launch.json'),'NATIVE_PUBLICATION_REFUSED')
        self.guard.verify();file=self.docker.storage/'runtime/control'/name
        temporary=file.with_name(str(uuid.uuid4())+'.pending');write_new(temporary,value);rename_handle(temporary,file,replace=True)
    def activate(self,phase,dispatch=None,session_id=None):
        require(not self.failed,'NATIVE_PHASE_RECOVERY_REQUIRED')
        try:return self._activate(phase,dispatch,session_id)
        except BaseException:self.failed=True;raise
    def _activate(self,phase,dispatch,session_id):
        require(self.session is None and self.thread is None,'NATIVE_PHASE_STILL_ACTIVE')
        session_id=session_id or str(uuid.uuid4());require(type(session_id) is str and UUID.fullmatch(session_id),'INVALID_NATIVE_SESSION');key=secrets.token_hex(32)
        # Re-prove the same bound socket with the new phase session and nonce.
        self.server=prove_server(self.docker,self.launch['controllerImage'],session_id,self.server)
        database=self.docker.storage/'runtime/native-phase.sqlite'
        if not database.exists():
            with PinnedPath(database,write=True,create=True,directory=False) as pin:pin.private()
        self.journal=Journal(str(database),session_id)
        proofs=StorageProofs(self.binding,secrets.token_hex(32),self.guard,FixedStorageProbe(self.docker,self.launch['controllerImage'],self.docker.uid,self.docker.gid))
        proof_id=proofs.issue();mapping=proofs.pending[proof_id][0]
        self.session=NativeSession(self.journal,phase,self.binding,key,proofs,proof_id,lambda:verify_route(self.server),self.docker.verify_engine,dispatch)
        route=self.server.route
        policy={'version':1,'revision':1,'platform':'win32','storageClass':'native-ntfs','phase':phase,**self.binding,'proofId':proof_id,'probeRevision':1,'issuedAt':mapping['issuedAt'],'expiresAt':mapping['expiresAt'],'slots':mapping['linux'],'broker':{'sessionId':session_id,'host':route['connectIP'],'port':route['port'],'route':route['proof']}}
        descriptor={'protocol':PROTOCOL,'sessionId':session_id,'key':key,'storageId':self.launch['storageId'],'launchId':self.launch['launchId'],'phase':phase,'transport':'tcp','host':route['connectIP'],'port':route['port']}
        self.publish('native-bind.json',policy);self.publish('session.json',descriptor)
        self.session.activate();self.server.RequestHandlerClass=self.session.handler()
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        return hashlib.sha256(canonical(policy).encode()).hexdigest(),session_id,mapping['linux']
    def revoke(self):
        try:self._revoke()
        except BaseException:self.failed=True;raise
    def _revoke(self):
        require(self.session is not None and self.thread is not None,'NO_NATIVE_PHASE')
        self.session.revoke();self.server.shutdown();self.thread.join(timeout=10)
        require(not self.thread.is_alive(),'NATIVE_PHASE_DRAIN_UNCERTAIN')
        self.journal.db.close();self.journal=None;self.session=None;self.thread=None
    def close_socket(self):
        require(self.session is None and self.thread is None,'NATIVE_PHASE_STILL_ACTIVE')
        if self.server:self.server.server_close();self.server=None
