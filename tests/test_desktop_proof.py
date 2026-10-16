import copy
from pathlib import Path
import sys
import unittest
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'containers/broker'))
from storage_proof import StorageProofs
from protocol import Denied
class Proofs(unittest.TestCase):
    def setUp(self):
        self.now=1000;self.calls=0
        self.binding={'storageId':str(uuid.uuid4()),'engineId':'engine','context':'desktop-linux','controllerImage':'sha256:'+'a'*64,'probeImage':'sha256:'+'b'*64,'launchId':str(uuid.uuid4())}
        entry={'volume':'123','fileId':'0'*32,'directory':True,'size':0,'ownerSid':'S-1-5-21-123','securityControl':4096,'protected':True,'aclDigest':'c'*64}
        self.native={'root':entry,'slots':{name:{**entry,'fileId':str(i)*32} for i,name in enumerate(['state','config','workspace','control'],1)}}
        self.guard=type('Guard',(),{'verify':lambda _self:copy.deepcopy(self.native)})()
        self.proofs=StorageProofs(self.binding,'d'*64,self.guard,self.probe,lambda:self.now)
    def probe(self,challenge):
        self.calls+=1
        return {**challenge,'slots':{name:{'dev':'5','ino':str(i)} for i,name in enumerate(['state','config','workspace','control'],1)},'sqlite':{'wal':True,'secondWriterDenied':True,'reopened':True}}
    def test_one_use_binding_and_domain_separated_host_state(self):
        token=self.proofs.issue();body=self.proofs.consume(token,self.binding)
        self.assertEqual(body['native'],self.native);self.assertEqual(self.calls,1)
        with self.assertRaisesRegex(Denied,'CONSUMED'):self.proofs.consume(token,self.binding)
    def test_acl_or_engine_changes_consume_and_veto(self):
        for change in ('acl','engine'):
            with self.subTest(change=change):
                self.setUp();token=self.proofs.issue();binding=dict(self.binding)
                if change=='acl':self.native['slots']['config']['aclDigest']='e'*64
                else:binding['engineId']='other'
                with self.assertRaises(Denied):self.proofs.consume(token,binding)
                with self.assertRaisesRegex(Denied,'FAILED'):self.proofs.issue()
                self.assertEqual(self.calls,1)
    def test_expired_proof_never_reprobes_pending_work(self):
        token=self.proofs.issue();self.now+=10001
        with self.assertRaisesRegex(Denied,'EXPIRED'):self.proofs.consume(token,self.binding)
        with self.assertRaisesRegex(Denied,'FAILED'):self.proofs.issue()
        self.assertEqual(self.calls,1)
    def test_timeout_or_lost_reply_does_not_retry(self):
        def lost(challenge):self.calls+=1;raise TimeoutError()
        self.proofs.probe=lost
        with self.assertRaises(TimeoutError):self.proofs.issue()
        with self.assertRaisesRegex(Denied,'FAILED'):self.proofs.issue()
        self.assertEqual(self.calls,1)
    def test_malformed_wrong_nonce_alias_and_unproven_sqlite_refused(self):
        for mutation in ('extra','nonce','alias','sqlite','bool-version','float-revision','int-wal','partial'):
            with self.subTest(mutation=mutation):
                self.setUp()
                def bad(challenge):
                    value=self.probe(challenge)
                    if mutation=='extra':value['extra']=True
                    elif mutation=='nonce':value['nonce']='0'*64
                    elif mutation=='alias':value['slots']['config']=value['slots']['state']
                    elif mutation=='sqlite':value['sqlite']['secondWriterDenied']=False
                    elif mutation=='bool-version':value['version']=True
                    elif mutation=='float-revision':value['revision']=1.0
                    elif mutation=='int-wal':value['sqlite']['wal']=1
                    else:del value['slots']['control']
                    return value
                self.proofs.probe=bad
                with self.assertRaises(Denied):self.proofs.issue()
                self.assertEqual(self.proofs.pending,{})

class Routes(unittest.TestCase):
    def test_only_exact_virtual_adapter_candidates_never_wildcard_or_lan(self):
        from windows_network import candidates
        adapter={'id':'adapter','name':'vEthernet (WSL)','description':'Hyper-V Virtual Ethernet Adapter','type':6,'status':1,'addresses':['172.28.48.1','0.0.0.0','8.8.8.8','169.254.1.1']}
        self.assertEqual([x['bind'] for x in candidates([adapter])],['127.0.0.1','172.28.48.1'])
        for field,value in [('name','Ethernet'),('description','Intel Ethernet'),('status',2),('type',71)]:
            with self.subTest(field=field):self.assertEqual(len(candidates([{**adapter,field:value}])),1)

if __name__=='__main__':unittest.main()
