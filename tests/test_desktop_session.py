"""Host phase authority faults. Synthetic guard, actual SQLite nonce journal."""
import copy
from pathlib import Path
import secrets
import sys
import unittest
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'containers/broker'))
from protocol import Journal,PROTOCOL,mac,now
from native_session import NativeSession
class Sessions(unittest.TestCase):
 def setUp(self):
  self.binding={'storageId':str(uuid.uuid4()),'launchId':str(uuid.uuid4())};self.key=secrets.token_hex(32);self.proof_id=secrets.token_hex(32);self.native={'identity':'original'};self.dispatches=[]
  outer=self
  class Guard:
   def verify(self):return dict(outer.native)
   def verify_roots(self):return self.verify()
  class Proofs:
   guard=Guard()
   def consume(self,token,binding):
    if token!=outer.proof_id or binding!=outer.binding:raise RuntimeError('wrong proof')
    return {'native':dict(outer.native)}
  self.journal=Journal(':memory:',str(uuid.uuid4()));self.clock=now();self.proofs=Proofs()
  self.session=NativeSession(self.journal,'initialize',self.binding,self.key,self.proofs,self.proof_id,lambda:None,lambda:None,clock=lambda:self.clock);self.session.activate()
 def tearDown(self):self.journal.db.close()
 def envelope(self,op,body):
  value={'protocol':PROTOCOL,'sessionId':self.journal.session,'nonce':secrets.token_hex(32),'expiresAt':now()+30000,'op':op,'body':body};return {**value,'mac':mac(value,self.key)}
 def redeem(self):return self.session.handle(self.envelope('redeem_storage',{'proofId':self.proof_id}))
 def test_initializer_never_dispatches_worker_install_transfer_shutdown_or_phase_change(self):
  self.redeem()
  for op in ['prepare','activate','install_prepare','transfer_begin','shutdown','phase','controller']:
   with self.assertRaisesRegex(Exception,'INITIALIZER_OPERATION_REFUSED'):self.session.handle(self.envelope(op,{}))
  self.assertEqual(self.session.handle(self.envelope('storage_check',{}))['launchId'],self.binding['launchId'])
 def test_proof_is_required_one_use_and_wrong_scope_does_not_redeem(self):
  with self.assertRaises(Exception):self.session.handle(self.envelope('storage_check',{}))
  with self.assertRaises(Exception):self.session.handle(self.envelope('redeem_storage',{'proofId':secrets.token_hex(32)}))
  self.redeem()
  with self.assertRaises(Exception):self.redeem()
 def test_replay_expiry_and_changed_native_guard_refuse(self):
  self.redeem();request=self.envelope('storage_check',{});self.session.handle(request)
  with self.assertRaises(Exception):self.session.handle(request)
  request=self.envelope('storage_check',{});request['expiresAt']=1;request['mac']=mac({k:v for k,v in request.items() if k!='mac'},self.key)
  with self.assertRaises(Exception):self.session.handle(request)
  self.native['identity']='changed'
  with self.assertRaisesRegex(Exception,'NATIVE_STORAGE_CHANGED'):self.session.handle(self.envelope('storage_check',{}))
  self.native['identity']='original'
  with self.assertRaises(Exception):self.session.handle(self.envelope('storage_check',{}))
 def test_revocation_reply_loss_leaves_durable_nonactive_phase_and_never_reactivates(self):
  self.redeem()
  def lost(phase):raise TimeoutError('lost transition reply')
  with self.assertRaises(TimeoutError):self.session.revoke(lost)
  self.assertEqual(self.journal.db.execute('SELECT state FROM native_sessions').fetchone()[0],'revoking')
  with self.assertRaisesRegex(Exception,'NATIVE_PHASE_RECOVERY_REQUIRED'):NativeSession(self.journal,'controller',self.binding,secrets.token_hex(32),self.proofs,self.proof_id,lambda:None,lambda:None)
  with self.assertRaises(Exception):self.session.activate()
  with self.assertRaises(Exception):self.session.handle(self.envelope('storage_check',{}))
 def test_initializer_credential_cannot_authenticate_new_controller_session(self):
  self.redeem();old=self.envelope('storage_check',{});self.session.revoke()
  journal=Journal(':memory:',str(uuid.uuid4()))
  try:
   controller=NativeSession(journal,'controller',self.binding,secrets.token_hex(32),self.proofs,self.proof_id,lambda:None,lambda:None,dispatch=lambda *args:self.dispatches.append(args));controller.activate()
   with self.assertRaises(Exception):controller.handle(old)
   self.assertFalse(self.dispatches)
  finally:journal.db.close()
 def test_clock_rollback_poison_is_not_renewed(self):
  self.redeem();self.clock-=1
  with self.assertRaisesRegex(Exception,'NATIVE_CLOCK_CHANGED'):self.session.handle(self.envelope('storage_check',{}))
  self.clock+=1000
  with self.assertRaises(Exception):self.session.handle(self.envelope('storage_check',{}))
 def test_long_dispatch_does_not_hold_storage_observation_authority(self):
  import threading,time
  self.session.revoke();entered=threading.Event();release=threading.Event()
  def dispatch(op,body):entered.set();release.wait(2);return {'done':True}
  self.journal.session=str(uuid.uuid4())
  controller=NativeSession(self.journal,'controller',self.binding,self.key,self.proofs,self.proof_id,lambda:None,lambda:None,dispatch=dispatch);controller.activate()
  controller.handle(self.envelope('redeem_storage',{'proofId':self.proof_id}))
  thread=threading.Thread(target=lambda:controller.handle(self.envelope('long_effect',{})));thread.start();self.assertTrue(entered.wait(1))
  try:
   started=time.monotonic();controller.handle(self.envelope('storage_check',{}));self.assertLess(time.monotonic()-started,.5)
  finally:release.set();thread.join(2)

if __name__=='__main__':unittest.main()
