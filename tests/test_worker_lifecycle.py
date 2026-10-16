import json
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parents[1]/'containers/broker'))
from protocol import Journal,Denied,now
from server import Broker

class Docker:
    def __init__(self):
        self.images={};self.image='sha256:'+'a'*64;self.storage_id=str(uuid.uuid4());self.contexts={};self.closed=[];self.fail=set();self.resources=self
    def close(self,context):
        self.closed.append(context)
        if context in self.fail:raise Denied('CLEANUP_UNCERTAIN')
        self.contexts.pop(context,None)
    def remove(self,id):self.close(id)

class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.journal=Journal(str(Path(self.tmp.name)/'claims.sqlite'),str(uuid.uuid4()));self.docker=Docker();self.broker=Broker(self.journal,self.docker)
    def tearDown(self):self.journal.db.close();self.tmp.cleanup()
    def prepared(self):
        request={'claimId':str(uuid.uuid4()),'project':'project','contextId':'b'*64,'operation':{'kind':'shell','command':'touch effect'},'timeoutMs':1000,'outputLimit':1000}
        identity={'storageId':self.docker.storage_id,'projectId':'c'*64,'imageId':self.docker.image,'layout':'d'*64}
        row=self.journal.prepare(request,identity);self.docker.contexts[request['contextId']]={}
        return row,{'claimId':row['claimId'],'binding':row['binding']}
    def test_install_started_between_prepare_and_activate_denies_activation(self):
        row,token=self.prepared()
        self.broker.packages.save({'id':str(uuid.uuid4()),'project':'project','phase':'executing','record':None})
        with self.assertRaisesRegex(Denied,'INSTALL_RECOVERY'):self.broker.dispatch('activate',token)
        self.assertEqual(self.journal.get(row['claimId'])['state'],'prepared')
    def test_consumed_preparation_denies_before_context_lookup(self):
        row,token=self.prepared();self.broker.dispatch('cancel',token)
        with self.assertRaisesRegex(Denied,'CLAIM_CONSUMED'):self.broker.dispatch('activate',token)
    def test_running_worker_denies_package_execute_before_effect(self):
        claim,token=self.prepared();claim['state']='running';self.journal.save(claim)
        decision={'requestId':str(uuid.uuid4()),'previewDigest':'e'*64,'decisionNonce':'f'*64,'expiresAt':now()+10000}
        row={'id':decision['requestId'],'project':'project','target':{'id':'original'},'phase':'authorized','record':{'expiresAt':decision['expiresAt'],'previewDigest':decision['previewDigest'],'decision':decision}}
        self.broker.packages.save(row)
        with patch.object(self.broker.packages,'target',return_value=row['target']),self.assertRaisesRegex(Denied,'PROJECT_EXECUTION_BUSY'):
            self.broker.dispatch('install_execute',{'project':'project','decision':decision})
        self.assertEqual(self.broker.packages.get(row['id'],'project')['phase'],'authorized')
        self.assertEqual(self.broker.packages.threads,{})
    def test_shutdown_admission_barrier_precedes_snapshot_and_repeated_shutdown_is_safe(self):
        broker=self.broker;observed=[]
        class Draining:
            def join(self,timeout):
                try:broker.dispatch('prepare',{})
                except Denied as error:observed.append(str(error))
            def is_alive(self):return False
        broker.packages.threads['install']=Draining()
        broker.shutdown();broker.shutdown()
        self.assertEqual(observed,['BROKER_CLOSING']);self.assertTrue(broker.shutdown_done.is_set())
    def test_shutdown_attempts_every_context_and_retains_cleanup_failure(self):
        self.docker.contexts={'one':{},'two':{}};self.docker.fail={'one'}
        with self.assertRaisesRegex(Denied,'DRAIN'):self.broker.shutdown()
        self.assertEqual(self.docker.closed,['one','two']);self.assertEqual(list(self.docker.contexts),['one'])
        with self.assertRaises(Denied):self.broker.shutdown()
    def test_package_cleanup_attempts_companion_after_maintenance_failure(self):
        row={'id':str(uuid.uuid4()),'container':'one','companion':'two','phase':'failed'};self.docker.fail={'one'}
        with self.assertRaisesRegex(Denied,'INSTALL_CLEANUP'):self.broker.packages.cleanup(row)
        self.assertEqual(self.docker.closed,['one','two']);self.assertEqual(row['container'],'one');self.assertIsNone(row['companion'])

if __name__=='__main__':unittest.main()
