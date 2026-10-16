import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'containers/broker'))

@unittest.skipUnless(os.name=='nt','Native phase files and actual Windows private DACLs')
class Phase(unittest.TestCase):
    def setUp(self):
        from windows_handles import privatize_empty,NativeStorageGuard
        from native_phase import NativePhase
        self.root=Path(tempfile.mkdtemp(prefix='m31-phase-',dir=os.environ.get('M31_TEST_ROOT'))).resolve();privatize_empty(self.root)
        for name in ('state','config','workspace','runtime','runtime/control'):(self.root/name).mkdir()
        self.guard=NativeStorageGuard(self.root);self.calls=[]
        self.launch={'storageId':str(uuid.uuid4()),'launchId':str(uuid.uuid4()),'context':'desktop-linux','engineId':'fixture-engine','controllerImage':'sha256:'+'a'*64}
        class Docker:
            uid=1000;gid=1000
            def verify_engine(self):pass
        self.docker=Docker();self.docker.storage=self.root
        from protocol import now
        def route(docker,image,session,retained=None):
            from route_probe import LocalServer
            import socketserver
            server=retained or LocalServer(('127.0.0.1',0),socketserver.StreamRequestHandler);port=server.server_address[1];issued=now()
            server.route={'connectIP':'127.0.0.1','bind':'127.0.0.1','connect':'127.0.0.1','adapterId':None,'port':port,'sessionId':session,'proof':{'version':1,'nonce':secrets.token_hex(32),'engineId':self.launch['engineId'],'probeImage':image,'address':'127.0.0.1','bindAddress':'127.0.0.1','port':port,'sessionId':session,'issuedAt':issued,'expiresAt':issued+30000}}
            return server
        def probe(*_):
            return lambda challenge:{**challenge,'slots':{name:{'dev':'5','ino':str(i)} for i,name in enumerate(('state','config','workspace','control'),1)},'sqlite':{'wal':True,'secondWriterDenied':True,'reopened':True}}
        self.patches=[patch('native_phase.prove_server',side_effect=route),patch('native_phase.verify_route'),patch('native_phase.FixedStorageProbe',side_effect=probe)]
        for item in self.patches:item.start()
        self.phase=NativePhase(self.docker,self.launch,self.guard)
    def tearDown(self):
        if self.phase.thread:
            try:self.phase.revoke()
            except Exception:self.phase.server.shutdown();self.phase.thread.join(timeout=2)
        if self.phase.server:self.phase.server.server_close()
        if self.phase.journal:self.phase.journal.db.close()
        self.guard.close()
        for item in reversed(self.patches):item.stop()
    def call(self,descriptor,op,body):
        from protocol import PROTOCOL,now,canonical,mac,decode
        value={'protocol':PROTOCOL,'sessionId':descriptor['sessionId'],'nonce':secrets.token_hex(32),'expiresAt':now()+30000,'op':op,'body':body}
        with socket.create_connection((descriptor['host'],descriptor['port']),timeout=3) as peer:
            peer.sendall((canonical({**value,'mac':mac(value,descriptor['key'])})+'\n').encode())
            with peer.makefile('rb') as stream:reply=decode(stream.readline(16385))
        self.assertEqual(reply['nonce'],value['nonce']);self.assertEqual(reply['mac'],mac({k:v for k,v in reply.items() if k!='mac'},descriptor['key']))
        return reply
    def test_separate_phase_credentials_same_socket_and_no_live_publication(self):
        digest,session,_=self.phase.activate('initialize');control=self.root/'runtime/control'
        initial=json.loads((control/'session.json').read_text());policy=json.loads((control/'native-bind.json').read_text())
        self.assertEqual(hashlib.sha256((control/'native-bind.json').read_bytes()).hexdigest(),digest)
        self.assertFalse(self.call(initial,'storage_check',{})['ok']);self.assertTrue(self.call(initial,'redeem_storage',{'proofId':policy['proofId']})['ok']);self.assertTrue(self.call(initial,'storage_check',{})['ok'])
        self.assertFalse(self.call(initial,'prepare',{})['ok'])
        with self.assertRaises(Exception):self.phase.publish('session.json',{})
        port=self.phase.server.server_address;self.phase.revoke()
        next_session=str(uuid.uuid4());self.phase.activate('controller',lambda op,body:self.calls.append(op) or {'available':True},next_session)
        current=json.loads((control/'session.json').read_text());policy=json.loads((control/'native-bind.json').read_text())
        self.assertEqual(self.phase.server.server_address,port);self.assertNotEqual(initial['key'],current['key']);self.assertNotEqual(initial['sessionId'],current['sessionId']);self.assertEqual(current['sessionId'],next_session)
        # Old credential receives a signed refusal under the new key, never authority.
        from protocol import PROTOCOL,now,canonical,mac,decode
        request={'protocol':PROTOCOL,'sessionId':initial['sessionId'],'nonce':secrets.token_hex(32),'expiresAt':now()+30000,'op':'storage_check','body':{}}
        with socket.create_connection((current['host'],current['port']),timeout=3) as peer:
            peer.sendall((canonical({**request,'mac':mac(request,initial['key'])})+'\n').encode())
            with peer.makefile('rb') as stream:reply=decode(stream.readline(16385))
        self.assertFalse(reply['ok']);self.assertEqual(self.calls,[])
        self.assertTrue(self.call(current,'redeem_storage',{'proofId':policy['proofId']})['ok']);self.assertTrue(self.call(current,'hello',{})['ok']);self.assertEqual(self.calls,['hello'])
    def test_lost_route_proof_never_retries_activation(self):
        with patch('native_phase.prove_server',side_effect=TimeoutError()) as observed:
            with self.assertRaises(TimeoutError):self.phase.activate('initialize')
            with self.assertRaisesRegex(Exception,'RECOVERY_REQUIRED'):self.phase.activate('initialize')
            self.assertEqual(observed.call_count,1)

if __name__=='__main__':unittest.main()
