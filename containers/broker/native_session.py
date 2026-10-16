"""Host-owned native phase/session authority on an already-proven bound socket.

No wire operation changes phase, chooses paths, or creates a mapping proof.
Initialization credentials are permanently revoked before controller activation.
"""
import secrets
import socketserver
import threading
from protocol import PROTOCOL,MAX_WIRE,HEX,Denied,require,exact,decode,canonical,mac,now

class NativeSession:
    def __init__(self,journal,phase,binding,key,proofs,proof_id,verify_route,verify_engine,dispatch=None,clock=now,targets=None):
        require(phase in ('initialize','controller'),'INVALID_NATIVE_PHASE')
        require(phase!='initialize' or dispatch is None,'INITIALIZER_DISPATCH_REFUSED')
        require(type(key) is str and HEX.fullmatch(key),'INVALID_NATIVE_KEY')
        self.targets=targets
        self.journal=journal;self.phase=phase;self.binding=dict(binding);self.key=key
        self.proofs=proofs;self.proof_id=proof_id;self.mapping=None;self.verify_route=verify_route;self.verify_engine=verify_engine
        self.dispatch=dispatch;self.clock=clock;self.last_clock=clock();self.lock=threading.RLock();self.failed=False;self.revoked=False
        self.proofs.guard.verify()
        self.journal.db.execute('CREATE TABLE IF NOT EXISTS native_sessions(session TEXT PRIMARY KEY,launch TEXT NOT NULL,phase TEXT NOT NULL,state TEXT NOT NULL)')
        with self.journal.db:
            require(self.journal.db.execute("SELECT count(*) FROM native_sessions WHERE state!='revoked'").fetchone()[0]==0,'NATIVE_PHASE_RECOVERY_REQUIRED')
            self.journal.db.execute('INSERT INTO native_sessions VALUES (?,?,?,?)',(journal.session,binding['launchId'],phase,'intent'))
    def activate(self):
        with self.lock:
            self.verify_route();self.verify_engine();self.proofs.guard.verify()
            self.state('intent','active')
    def state(self,before,after):
        with self.journal.db:
            count=self.journal.db.execute('UPDATE native_sessions SET state=? WHERE session=? AND launch=? AND phase=? AND state=?',(after,self.journal.session,self.binding['launchId'],self.phase,before)).rowcount
            require(count==1,'NATIVE_SESSION_CHANGED')
    def revoke(self,checkpoint=lambda _:None):
        with self.lock:
            self.revoked=True
            self.state('active','revoking');checkpoint('revoking')
            self.state('revoking','revoked');checkpoint('revoked')
    def fresh(self):
        require(not self.failed and not self.revoked,'NATIVE_SESSION_REVOKED')
        try:
            current=self.clock();require(current>=self.last_clock,'NATIVE_CLOCK_CHANGED');self.last_clock=current
            row=self.journal.db.execute('SELECT launch,phase,state FROM native_sessions WHERE session=?',(self.journal.session,)).fetchone()
            require(row==(self.binding['launchId'],self.phase,'active'),'NATIVE_SESSION_CHANGED')
            self.verify_route();self.verify_engine();native=self.proofs.guard.verify_roots()
            if self.mapping:require(native==self.mapping['native'],'NATIVE_STORAGE_CHANGED')
        except BaseException:self.failed=True;raise
    def handle(self,envelope):
        with self.lock:
            self.fresh();op,body=self.journal.authenticate(envelope,self.key)
            if self.phase=='initialize':require(op in ('redeem_storage','storage_check','storage_targets'),'INITIALIZER_OPERATION_REFUSED')
            if op=='redeem_storage':
                exact(body,['proofId']);require(self.mapping is None and body['proofId']==self.proof_id,'PROOF_CONSUMED_OR_UNKNOWN')
                try:self.mapping=self.proofs.consume(body['proofId'],self.binding)
                except BaseException:self.failed=True;raise
                return {'storageId':self.binding['storageId'],'launchId':self.binding['launchId'],'redeemed':True}
            require(self.mapping is not None,'NATIVE_PROOF_REQUIRED');self.fresh()
            if op=='storage_check':
                exact(body,[]);issued=self.clock()
                return {'storageId':self.binding['storageId'],'launchId':self.binding['launchId'],'gateId':secrets.token_hex(32),'issuedAt':issued,'expiresAt':issued+10000}
            if op=='storage_targets':
                exact(body,['targets']);require(self.targets is not None,'PRIVATE_TARGETS_UNAVAILABLE')
                from storage_targets import target_digest
                bound=target_digest(body['targets'],self.binding,self.journal.session,self.phase)
                try:self.targets.observe(body['targets'])
                except BaseException:self.failed=True;raise
                issued=self.clock()
                return {'storageId':self.binding['storageId'],'launchId':self.binding['launchId'],'gateId':secrets.token_hex(32),'issuedAt':issued,'expiresAt':issued+10000,'targetsDigest':bound}
            require(self.phase=='controller' and self.dispatch is not None,'NATIVE_OPERATION_REFUSED')
            dispatch=self.dispatch
        # Do not hold phase/observation authority while a serialized broker
        # dispatch waits on PTY/install/transfer work. Each adapter rechecks fresh
        # authority at its final claim barrier; observations never wait for it.
        return dispatch(op,body)
    def handler(self):
        authority=self
        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                self.request.settimeout(35);envelope=None
                try:
                    envelope=decode(self.rfile.readline(MAX_WIRE+1));result=authority.handle(envelope)
                    unsigned={'protocol':PROTOCOL,'sessionId':authority.journal.session,'nonce':envelope['nonce'],'ok':True,'result':result}
                except Exception as error:
                    if type(envelope) is not dict or type(envelope.get('nonce')) is not str or not HEX.fullmatch(envelope['nonce']):return
                    import re
                    code=str(error) if isinstance(error,Denied) and re.fullmatch('[A-Z_]{1,64}',str(error)) else 'NATIVE_SESSION_FAILED'
                    unsigned={'protocol':PROTOCOL,'sessionId':authority.journal.session,'nonce':envelope['nonce'],'ok':False,'error':code}
                self.wfile.write((canonical({**unsigned,'mac':mac(unsigned,authority.key)})+'\n').encode());self.wfile.flush()
        return Handler
