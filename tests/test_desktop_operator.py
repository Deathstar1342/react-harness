import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'containers/broker'))

@unittest.skipUnless(os.name=='nt','Actual Windows retained native operator process')
class OperatorProcess(unittest.TestCase):
    def setUp(self):
        from windows_handles import privatize_empty
        self.root=Path(tempfile.mkdtemp(prefix='m31-operator-',dir=os.environ.get('M31_TEST_ROOT'))).resolve();privatize_empty(self.root)
        for name in ('state','config','workspace','runtime','runtime/control'):(self.root/name).mkdir()
        self.binding={'storageId':str(uuid.uuid4()),'launchId':str(uuid.uuid4()),'engineId':'fixture-engine','context':'desktop-linux','controllerImage':'sha256:'+'a'*64,'workerImage':'sha256:'+'b'*64,'sourceDigest':'c'*64,'runtimeDigest':'d'*64}
        self.children=[];self.record=None
    def start(self,role='host',fail_drain=False,publication_fault=None):
        env={key:os.environ[key] for key in ('SystemRoot','WINDIR','TEMP','TMP') if key in os.environ}
        child=subprocess.Popen([sys.executable,'-I','-B',str(Path(__file__).with_name('native-operator-fixture.py')),role],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,creationflags=subprocess.CREATE_NO_WINDOW)
        self.children.append(child);child.stdin.write(json.dumps({'storage':str(self.root),'binding':self.binding,'failDrain':fail_drain,'publicationFault':publication_fault})+'\n');child.stdin.flush()
        return child,json.loads(child.stdout.readline())
    def load(self):
        from windows_handles import NativeStorageGuard
        from native_operator import descriptor
        with NativeStorageGuard(self.root) as guard:return descriptor(self.root,self.binding,guard)
    def drained(self):
        from windows_handles import exclusive_lock
        from native_operator import read_record
        end=time.monotonic()+8
        while time.monotonic()<end:
            try:
                with exclusive_lock(self.root/'runtime/operator/lifetime.lock'):
                    self.assertEqual(read_record(self.root/'runtime/operator')['phase'],'drained');return
            except BlockingIOError:time.sleep(.02)
        self.fail('exact native lifetime lease not released')
    def tearDown(self):
        from native_operator import request
        if self.record:
            try:request(self.record,{'op':'drain'})
            except Exception:pass
        for child in self.children:
            if child.poll() is None:
                child.kill() # Exact test-owned Popen only, never guessed PID.
            child.wait(timeout=5)
            for stream in (child.stdin,child.stdout,child.stderr):
                if stream:stream.close()
    def test_parent_loss_reconnect_duplicate_refusal_and_clean_drain(self):
        from native_operator import request,descriptor
        from windows_handles import NativeStorageGuard
        parent,result=self.start('parent');self.assertEqual(result,{'ready':True});self.record=self.load()
        self.assertEqual(request(self.record,{'op':'status'}),{'fixture':True,'alive':True})
        parent.kill();parent.wait(timeout=5)
        self.assertEqual(self.load(),self.record);self.assertTrue(request(self.record,{'op':'status'})['alive'])
        duplicate,result=self.start();self.assertIn('failure',result);self.assertEqual(duplicate.wait(timeout=5),2)
        wrong={**self.record,'key':secrets.token_hex(32)}
        with self.assertRaises(Exception):request(wrong,{'op':'status'})
        wrong={**self.record,'instanceId':str(uuid.uuid4())}
        with self.assertRaises(Exception):request(wrong,{'op':'status'})
        with self.assertRaises(Exception):request(self.record,{'op':'execute','command':'unused'})
        self.assertTrue(request(self.record,{'op':'status'})['alive'])
        self.assertEqual(request(self.record,{'op':'drain'}),{'stopped':True})
        from native_operator import wait_drained
        with NativeStorageGuard(self.root) as guard:self.assertEqual(wait_drained(self.root,self.record,guard),{'stopped':True})
        self.drained()
        with self.assertRaises(Exception):request(self.record,{'op':'status'},timeout=.5)
        self.record=None
    def test_reply_loss_consumes_nonce_and_incomplete_wire_has_no_effect(self):
        import socket
        from protocol import canonical,mac,digest,now,decode
        from native_operator import PROTOCOL
        child,result=self.start();self.assertEqual(result,{'ready':True});self.record=self.load();r=self.record
        body={'protocol':PROTOCOL,'instanceId':r['instanceId'],'sessionId':r['sessionId'],'binding':digest(r['binding']),'nonce':secrets.token_hex(32),'expiresAt':now()+30000,'request':{'op':'transfer-discard','handle':'e'*64}}
        wire=(canonical({**body,'mac':mac(body,r['key'])})+'\n').encode()
        with socket.create_connection((r['host'],r['port']),timeout=2) as peer:peer.sendall(wire) # Deliberately drop reply.
        effect=self.root/'runtime/operator/fixture-effects';end=time.monotonic()+3
        while not effect.exists():self.assertLess(time.monotonic(),end);time.sleep(.01)
        self.assertEqual(effect.read_bytes(),b'x')
        with socket.create_connection((r['host'],r['port']),timeout=2) as peer:
            peer.sendall(wire)
            with peer.makefile('rb') as stream:reply=decode(stream.readline(16385))
        self.assertFalse(reply['ok']);self.assertEqual(effect.read_bytes(),b'x')
        with socket.create_connection((r['host'],r['port']),timeout=2) as peer:peer.sendall(wire[:-20]);peer.shutdown(socket.SHUT_WR)
        time.sleep(.05);self.assertEqual(effect.read_bytes(),b'x')
    def test_partial_journal_and_failed_drain_remain_nonactive(self):
        from native_operator import request
        from transfer_service import write_new,private_json
        area=self.root/'runtime/operator';area.mkdir();write_new(area/'orphan.pending',{'intent':True})
        child,result=self.start();self.assertIn('failure',result);self.assertEqual(child.wait(timeout=5),2)
        # A separate fresh storage fixture exercises drain refusal, never reset partial storage.
        self.root=Path(tempfile.mkdtemp(prefix='m31-operator-drain-',dir=os.environ.get('M31_TEST_ROOT'))).resolve()
        from windows_handles import privatize_empty
        privatize_empty(self.root)
        for name in ('state','config','workspace','runtime','runtime/control'):(self.root/name).mkdir()
        child,result=self.start(fail_drain=True);self.assertEqual(result,{'ready':True});self.record=self.load()
        with self.assertRaises(Exception):request(self.record,{'op':'drain'})
        self.assertEqual(private_json(self.root/'runtime/operator/current.json')['phase'],'uncertain')
        with self.assertRaises(Exception):request(self.record,{'op':'status'})
    def test_changed_owner_record_restoration_never_reactivates(self):
        from native_operator import request
        child,result=self.start();self.assertEqual(result,{'ready':True});self.record=self.load()
        file=self.root/'runtime/operator/current.json';original=file.read_bytes();changed=json.loads(original);changed['instanceId']=str(uuid.uuid4());file.write_text(json.dumps(changed))
        with self.assertRaises(Exception):request(self.record,{'op':'status'})
        file.write_bytes(original)
        with self.assertRaises(Exception):request(self.record,{'op':'status'})
    def test_changed_native_acl_restoration_never_reactivates(self):
        from native_operator import request
        from windows_handles import current_sid,NativeStorageGuard
        from test_desktop_windows import NativeHandles
        import windows_handles as native
        child,result=self.start();self.assertEqual(result,{'ready':True});self.record=self.load()
        # Active status reads this exact private record; unrelated configuration
        # now receives its own target proof when the controller accesses it.
        file=self.root/'runtime/operator/current.json'
        helper=NativeHandles();helper.native=native;user=current_sid()
        helper.set_acl(file,f'O:{user}D:P(A;;FA;;;{user})(A;;FA;;;WD)')
        with self.assertRaises(Exception):request(self.record,{'op':'status'})
        helper.set_acl(file,f'O:{user}D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{user})')
        with NativeStorageGuard(self.root) as guard:self.assertEqual(guard.verify(),self.record['native'])
        with self.assertRaises(Exception):request(self.record,{'op':'status'})
    def test_unauthenticated_connection_admission_is_bounded(self):
        import socket
        from native_operator import request
        child,result=self.start();self.assertEqual(result,{'ready':True});self.record=self.load();r=self.record;peers=[]
        try:
            for _ in range(8):
                peer=socket.create_connection((r['host'],r['port']),timeout=2);peer.sendall(b'{');peers.append(peer)
            time.sleep(.1)
            with socket.create_connection((r['host'],r['port']),timeout=2) as refused:
                refused.settimeout(2);self.assertEqual(refused.recv(1),b'')
        finally:
            for peer in peers:peer.close()
        end=time.monotonic()+2
        while True:
            try:self.assertTrue(request(r,{'op':'status'},timeout=1)['alive']);break
            except Exception:
                self.assertLess(time.monotonic(),end);time.sleep(.02)
    def test_held_private_reader_serializes_drain_publication_and_guard(self):
        import concurrent.futures
        from native_operator import request,wait_drained,read_record
        from windows_handles import operator_record_lock,PinnedPath,NativeStorageGuard
        child,result=self.start();self.assertEqual(result,{'ready':True});self.record=self.load();area=self.root/'runtime/operator'
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            with operator_record_lock(area),PinnedPath(area/'current.json',directory=False) as reader:
                reader.private();future=pool.submit(request,self.record,{'op':'drain'})
                time.sleep(.15);self.assertFalse(future.done());self.assertEqual(read_record(area)['phase'],'active')
                # Reentrant same-thread observation while a reader holds the lock.
                with NativeStorageGuard(self.root) as guard:self.assertEqual(guard.verify(),self.record['native'])
            self.assertEqual(future.result(timeout=5),{'stopped':True})
        with NativeStorageGuard(self.root) as guard:self.assertEqual(wait_drained(self.root,self.record,guard),{'stopped':True})
        self.record=None
    def test_concurrent_guard_observation_nonce_commits_and_drain(self):
        import threading
        from native_operator import request,read_record,wait_drained
        from windows_handles import NativeStorageGuard
        child,result=self.start();self.assertEqual(result,{'ready':True});self.record=self.load();stop=threading.Event();errors=[]
        def observe():
            try:
                with NativeStorageGuard(self.root) as guard:
                    while not stop.is_set():guard.verify();read_record(self.root/'runtime/operator');stop.wait(.002)
            except BaseException as error:errors.append(type(error).__name__)
        observer=threading.Thread(target=observe);observer.start()
        try:
            for _ in range(15):self.assertEqual(request(self.record,{'op':'transfer-discard','handle':'f'*64}),{'discarded':True})
            self.assertEqual(request(self.record,{'op':'drain'}),{'stopped':True})
            with NativeStorageGuard(self.root) as guard:self.assertEqual(wait_drained(self.root,self.record,guard),{'stopped':True})
            self.record=None
        finally:stop.set();observer.join(timeout=5)
        self.assertFalse(observer.is_alive());self.assertEqual(errors,[])
    def test_interrupted_publication_never_restarts_or_removes_intent(self):
        from windows_handles import privatize_empty
        for fault in ('stage','receipt'):
            with self.subTest(fault=fault):
                self.root=Path(tempfile.mkdtemp(prefix='m31-operator-fault-',dir=os.environ.get('M31_TEST_ROOT'))).resolve();privatize_empty(self.root)
                for name in ('state','config','workspace','runtime','runtime/control'):(self.root/name).mkdir()
                child,result=self.start(publication_fault=fault);self.assertIn('failure',result);self.assertEqual(child.wait(timeout=5),2)
                intent=self.root/'.native-operator-intent.json';self.assertTrue(intent.exists());before=intent.read_bytes()
                next_child,result=self.start();self.assertIn('failure',result);self.assertEqual(next_child.wait(timeout=5),2)
                self.assertEqual(intent.read_bytes(),before)
    def test_record_lock_timeout_is_bounded_and_observation_does_not_create(self):
        import concurrent.futures
        from windows_handles import operator_record_lock
        child,result=self.start();self.assertEqual(result,{'ready':True});self.record=self.load();area=self.root/'runtime/operator'
        def attempt():
            with operator_record_lock(area,timeout=.05):raise AssertionError('held lock acquired')
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            with operator_record_lock(area):
                future=pool.submit(attempt)
                with self.assertRaises(TimeoutError):future.result(timeout=1)
        missing=self.root/'runtime/absent';missing.mkdir()
        with self.assertRaises(OSError):
            with operator_record_lock(missing):pass
        self.assertEqual(list(missing.iterdir()),[])
    @unittest.skipUnless(os.environ.get('M31_ELECTRON_EXE'),'Actual Electron binary supplied explicitly')
    def test_actual_electron_parent_loss_retains_authenticated_native_child(self):
        from native_operator import request,wait_drained
        from windows_handles import NativeStorageGuard
        user_data=self.root.parent/('m31-electron-userdata-'+str(uuid.uuid4()));user_data.mkdir()
        env={key:os.environ[key] for key in ('SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE') if key in os.environ}
        bootstrap=self.root/'electron-fixture.json';bootstrap.write_text(json.dumps({'storage':str(self.root),'binding':self.binding,'python':sys.executable,'fixture':str(Path(__file__).with_name('native-operator-fixture.py')),'userData':str(user_data)}))
        child=subprocess.Popen([os.environ['M31_ELECTRON_EXE'],str(Path(__file__).with_name('native-operator-electron.cjs')),str(bootstrap)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,creationflags=subprocess.CREATE_NO_WINDOW)
        self.children.append(child)
        import queue,threading
        output=queue.Queue()
        def ready_line():
            for _ in range(8):
                line=child.stdout.readline(16385)
                if not line or line.strip():output.put(line);return
            output.put('too many startup lines')
        threading.Thread(target=ready_line,daemon=True).start()
        line=output.get(timeout=15)
        self.assertEqual(json.loads(line),{'ready':True});self.record=self.load()
        child.kill();child.wait(timeout=5)
        self.assertEqual(self.load(),self.record);self.assertTrue(request(self.record,{'op':'status'})['alive'])
        self.assertEqual(request(self.record,{'op':'drain'}),{'stopped':True})
        with NativeStorageGuard(self.root) as guard:self.assertEqual(wait_drained(self.root,self.record,guard),{'stopped':True})
        self.record=None
    def test_crashed_owner_does_not_start_again(self):
        from native_operator import request
        child,result=self.start();self.assertEqual(result,{'ready':True});self.record=self.load()
        child.kill();child.wait(timeout=5)
        next_child,result=self.start();self.assertIn('failure',result);self.assertEqual(next_child.wait(timeout=5),2)
        with self.assertRaises(Exception):request(self.record,{'op':'status'},timeout=.5)
        self.record=None

if __name__=='__main__':unittest.main()
