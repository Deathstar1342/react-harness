import os
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'containers/broker'))
from transfers import component, policy, scan, copy, publish

class TransferPolicy(unittest.TestCase):
    def test_unsafe_names(self):
        for name in ['../escape', 'CON.txt', 'x:y', 'x.', 'x ', 'nul', 'a\\b', 'e\u0301']:
            with self.subTest(name=name), self.assertRaises(Exception): component(name)
    def test_policy(self):
        self.assertIsNotNone(policy('.env', [], False))
        self.assertIsNone(policy('.env', ['.env'], False))
        self.assertIsNotNone(policy('.aws/credentials', ['.aws/credentials'], False))
        self.assertIsNotNone(policy('node_modules/x', [], False))
        self.assertIsNotNone(policy('.git/config', [], True))
        self.assertIsNone(policy('.git/objects/ab/0123', [], True))
        with self.assertRaises(Exception): policy('.git/objects/info/alternates', [], True)

@unittest.skipUnless(os.name == 'posix', 'Linux descriptor-relative source implementation')
class TransferCopy(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root/'source'; self.source.mkdir()
        (self.source/'file.txt').write_bytes(b'dirty working bytes')
    def tearDown(self): self.temp.cleanup()
    def test_copy_preserves_source_and_no_clobber(self):
        before=(self.source/'file.txt').stat()
        (self.source/'.env').write_text('ordinary=private')
        manifest=scan(self.source)
        self.assertEqual(manifest['excluded'][0]['path'],'.env')
        stage=self.root/'stage'; copy(self.source,stage,manifest)
        self.assertEqual((stage/'file.txt').read_bytes(), b'dirty working bytes')
        self.assertFalse((stage/'.env').exists())
        self.assertTrue((stage/'.git/HEAD').exists())
        after=(self.source/'file.txt').stat()
        self.assertEqual((before.st_mtime_ns,before.st_mode),(after.st_mtime_ns,after.st_mode))
        destination=self.root/'destination'; destination.mkdir()
        with self.assertRaises(OSError): publish(stage,destination)
        self.assertTrue(stage.exists()); self.assertEqual(list(destination.iterdir()),[])
        destination.rmdir(); publish(stage,destination)
        self.assertTrue((destination/'file.txt').exists())
    def test_change_rejected(self):
        manifest=scan(self.source)
        (self.source/'file.txt').write_text('changed')
        with self.assertRaises(Exception): copy(self.source,self.root/'stage',manifest)
    def test_links_collisions_secrets(self):
        (self.source/'link').symlink_to(self.root)
        with self.assertRaises(Exception): scan(self.source)
        (self.source/'link').unlink()
        (self.source/'FILE.txt').write_text('collision')
        with self.assertRaises(Exception): scan(self.source)
        (self.source/'FILE.txt').unlink()
        (self.source/'file.txt').write_text('STARK_API_KEY=must-never-copy')
        self.assertEqual(scan(self.source)['bytes'],len(b'STARK_API_KEY=must-never-copy'))
        with self.assertRaises(Exception): scan(self.source,secrets=[b'must-never-copy'])
    def test_cancel_preserves_residue(self):
        manifest=scan(self.source)
        def stop(): raise InterruptedError()
        with self.assertRaises(InterruptedError): copy(self.source,self.root/'stage',manifest,check=stop)
        self.assertTrue((self.root/'stage').exists())
        self.assertEqual((self.source/'file.txt').read_bytes(),b'dirty working bytes')


@unittest.skipUnless(os.name == 'posix', 'Linux host transfer implementation')
class TransferFaults(unittest.TestCase):
    def setUp(self):
        import uuid
        from protocol import Journal
        from server import Broker
        self.tmp=tempfile.TemporaryDirectory();self.base=Path(self.tmp.name)
        self.storage=self.base/'storage';self.storage.mkdir(mode=0o700)
        for name in ('runtime','runtime/control','workspace'): (self.storage/name).mkdir(mode=0o700)
        self.sid=str(uuid.uuid4());(self.storage/'.storage-id').write_text(self.sid+'\n')
        self.journal=Journal(str(self.storage/'runtime/journal.sqlite'),str(uuid.uuid4()))
        class Docker:
            contexts={};images={}
            def __init__(self,storage,sid):self.storage=storage;self.storage_id=sid
        self.broker=Broker(self.journal,Docker(self.storage,self.sid))
        from transfer_service import area,write_new
        area(self.storage)
        self.broker.transfers.verify_journal()
        write_new(self.storage/'runtime/control/session.json',{'storageId':self.sid,'sessionId':self.journal.session})
        self.source=self.base/'original';self.source.mkdir();(self.source/'file').write_text('original')
        self.install=self.base/'install';self.install.mkdir()
    def tearDown(self):
        self.broker.transfers.close();self.journal.db.close();self.tmp.cleanup()
    def ticket(self,kind='import',destination=None,project=None):
        from transfer_service import select,authorize
        token,ticket=select(str(self.storage),self.sid,str(self.install),kind,str(destination or self.source),project)
        authorize(self.storage,token,ticket);return token,ticket
    def wait(self,token):
        import time
        for _ in range(300):
            result=self.broker.dispatch('transfer_observe',{'code':token})
            if result['phase'] not in ('copying','publishing'):return result
            time.sleep(.01)
        self.fail('transfer did not finish')
    def test_published_identity_one_use_receipt_and_no_replay(self):
        token,ticket=self.ticket()
        self.broker.dispatch('transfer_begin',{'code':token,'kind':'import','project':None})
        result=self.wait(token);self.assertEqual(result['phase'],'succeeded',result)
        self.assertEqual((Path(ticket['destination'])/'file').read_text(),'original')
        self.assertEqual(self.broker.dispatch('transfer_receipt',{'code':token}),result)
        with self.assertRaises(Exception):self.broker.dispatch('transfer_receipt',{'code':token})
        with self.assertRaises(Exception):self.broker.dispatch('transfer_begin',{'code':token,'kind':'import','project':None})
    def test_sensitive_selected_roots_and_links_refused(self):
        from transfer_service import select
        credential=self.base/'.aws';credential.mkdir();(credential/'credentials').write_text('private')
        with self.assertRaises(Exception):select(str(self.storage),self.sid,str(self.install),'import',str(credential))
        link=self.base/'link';link.symlink_to(self.source)
        with self.assertRaises(Exception):select(str(self.storage),self.sid,str(self.install),'import',str(link))
        with self.assertRaises(Exception):select(str(self.storage),self.sid,str(self.install),'import',str(self.storage/'runtime'))
    def test_stage_and_parent_replacement_refused(self):
        from transfers import verify_stage,stamp
        manifest=scan(self.source);stage=self.base/'stage';copy(self.source,stage,manifest)
        identity=verify_stage(stage,manifest)
        (stage/'file').write_text('tampered')
        with self.assertRaises(Exception):verify_stage(stage,manifest)
        renamed=self.base/'renamed';stage.rename(renamed);stage.mkdir()
        with self.assertRaises(Exception):publish(stage,self.base/'destination',identity,stamp(self.base.stat())[:2])
        self.assertFalse((self.base/'destination').exists())
        stage.rmdir();renamed.rename(stage)
        with self.assertRaises(Exception):publish(stage,self.base/'destination',identity,[0,0])
    def test_changed_source_cannot_publish_or_replay(self):
        token,ticket=self.ticket();(self.source/'file').write_text('new bytes')
        self.broker.dispatch('transfer_begin',{'code':token,'kind':'import','project':None})
        result=self.wait(token);self.assertEqual(result['phase'],'failed');self.assertTrue(result['residue'])
        self.assertFalse(Path(ticket['destination']).exists());self.assertEqual((self.source/'file').read_text(),'new bytes')
    def test_cancel_drain_and_export_host_gate(self):
        import threading
        from unittest.mock import patch
        from transfer_service import copy as real_copy
        gate=threading.Event();entered=threading.Event()
        def delayed(*args,**kwargs):
            entered.set();gate.wait(5);return real_copy(*args,**kwargs)
        # Publish a managed import first.
        token,ticket=self.ticket();self.broker.dispatch('transfer_begin',{'code':token,'kind':'import','project':None});self.assertEqual(self.wait(token)['phase'],'succeeded')
        code,export=self.ticket('export',self.base/'export',ticket['project'])
        with patch('transfer_service.copy',delayed):
            self.broker.dispatch('transfer_begin',{'code':code,'kind':'export','project':ticket['project']});self.assertTrue(entered.wait(2))
            for op in ('install_prepare','reset'):
                with self.assertRaisesRegex(Exception,'TRANSFER_BUSY'):self.broker.dispatch(op,{'project':ticket['project']})
            import uuid
            with self.assertRaisesRegex(Exception,'TRANSFER_BUSY'):
                self.broker.dispatch('prepare',{'claimId':str(uuid.uuid4()),'project':ticket['project'],'contextId':'a'*64,'operation':{'kind':'shell','command':'echo must-not-run'},'timeoutMs':1000,'outputLimit':1000})
            self.assertTrue(self.broker.transfers.busy(ticket['project']))
            self.broker.dispatch('transfer_cancel',{'code':code});self.assertTrue(self.broker.transfers.busy(ticket['project']))
            gate.set();self.assertEqual(self.wait(code)['phase'],'cancelled')
        self.assertFalse(Path(export['destination']).exists());self.assertTrue(self.source.exists())
    def test_restart_marks_claim_uncertain_without_copying(self):
        from transfer_service import Transfers
        token,ticket=self.ticket()
        row={**ticket,'phase':'copying','code':'COPYING','residue':True,'manifestDigest':ticket['manifest']['digest'],'files':1,'bytes':8,'excludedCount':0,'excluded':[],'history':False,'identity':None}
        self.broker.transfers.save(row)
        self.broker.transfers=Transfers(self.broker)
        self.assertEqual(self.broker.dispatch('transfer_observe',{'code':token})['phase'],'uncertain')
        self.assertFalse(Path(ticket['destination']).exists())
        with self.assertRaises(Exception):self.broker.dispatch('transfer_begin',{'code':token,'kind':'import','project':None})



    def test_release_tombstones_delayed_begin_and_refuses_wrong_session(self):
        token,ticket=self.ticket();self.broker.dispatch('transfer_begin',{'code':token,'kind':'import','project':None});self.assertEqual(self.wait(token)['phase'],'succeeded')
        code,export=self.ticket('export',self.base/'released-export',ticket['project'])
        body={'code':code,'project':ticket['project'],'sessionId':export['sessionId'],'transferId':None,'manifestDigest':None}
        with self.assertRaises(Exception):self.broker.dispatch('transfer_release',{**body,'sessionId':'wrong'})
        with self.assertRaises(Exception):self.broker.dispatch('transfer_release',{**body,'project':'wrong'})
        result=self.broker.dispatch('transfer_release',body);self.assertEqual(result,{'released':True,'receipt':None})
        with self.assertRaises(Exception):self.broker.dispatch('transfer_begin',{'code':code,'kind':'export','project':ticket['project']})
        self.assertEqual(self.broker.dispatch('transfer_release',body),result)
        self.assertFalse(Path(export['destination']).exists())
    def test_journal_continuity_and_active_thread_release(self):
        from transfer_service import Transfers
        from unittest.mock import Mock
        token,ticket=self.ticket();self.broker.dispatch('transfer_begin',{'code':token,'kind':'import','project':None});self.assertEqual(self.wait(token)['phase'],'succeeded')
        code,export=self.ticket('export',self.base/'thread-export',ticket['project'])
        self.broker.dispatch('transfer_begin',{'code':code,'kind':'export','project':ticket['project']});self.assertEqual(self.wait(code)['phase'],'succeeded')
        thread=self.broker.transfers.threads[export['id']];thread.join(2)
        self.broker.transfers.threads[export['id']]=Mock(is_alive=lambda:True)
        body={'code':code,'project':ticket['project'],'sessionId':export['sessionId'],'transferId':export['id'],'manifestDigest':export['manifest']['digest']}
        with self.assertRaises(Exception):self.broker.dispatch('transfer_release',body)
        self.broker.transfers.threads[export['id']]=thread
        result=self.broker.dispatch('transfer_release',body);self.assertTrue(result['released'])
        self.broker.transfers=Transfers(self.broker);self.broker.transfers.verify_journal()
        self.assertEqual(self.broker.dispatch('transfer_release',body),result)
        self.journal.db.execute('DELETE FROM transfer_identity');self.journal.db.commit()
        replaced=Transfers(self.broker)
        with self.assertRaises(Exception):replaced.verify_journal()
        with self.assertRaises(Exception):replaced.dispatch('transfer_release',body)

if __name__ == '__main__': unittest.main()
