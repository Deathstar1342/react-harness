"""Fault injection for exact socket-volume lineage; no daemon is contacted."""
import json
from pathlib import Path
import sqlite3
import sys
import threading
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'containers/broker'))
from socket_egress import SocketEgress
class Volumes(unittest.TestCase):
 def setUp(self):
  self.volumes={};self.calls=[];self.in_use=False;self.lose_remove_reply=False
  outer=self
  class Docker:
   image='sha256:'+'a'*64;storage_id='storage'
   resources=type('Resources',(),{'db':sqlite3.connect(':memory:'),'lock':threading.RLock()})()
   def call(self,args):
    outer.calls.append(args)
    if args[:2]==['volume','create']:
     name=args[-1];labels={args[i+1].split('=',1)[0]:args[i+1].split('=',1)[1] for i,v in enumerate(args) if v=='--label'}
     outer.volumes[name]={'Name':name,'Driver':'local','Scope':'local','Labels':labels,'Options':None,'CreatedAt':'fixed-created-time','Mountpoint':'/engine/volumes/'+name+'/_data'}
     raise TimeoutError('lost create reply after effect')
    if args[:2]==['volume','ls']:
     name=args[3].removeprefix('name=^').removesuffix('$');return name+'\n' if name in outer.volumes else ''
    if args[:2]==['volume','inspect']:return json.dumps([outer.volumes[args[2]]])
    if args[:2]==['volume','rm']:
     if outer.in_use:raise RuntimeError('volume still in use')
     del outer.volumes[args[2]]
     if outer.lose_remove_reply:raise TimeoutError('lost removal reply after effect')
     return args[2]
    raise AssertionError('unexpected Docker operation')
  self.docker=Docker();self.proxy=SocketEgress(self.docker)
 def tearDown(self):self.docker.resources.db.close()
 def test_lost_creation_reply_is_cleanup_only_never_replayed(self):
  with self.assertRaises(TimeoutError):self.proxy.start()
  self.assertEqual(len(self.volumes),1);self.assertEqual(self.proxy.row['phase'],'intent')
  self.proxy.recover();self.assertEqual(self.volumes,{})
  self.assertEqual(sum(c[:2]==['volume','create'] for c in self.calls),1)
 def test_changed_owner_or_in_use_volume_retains_uncertainty(self):
  with self.assertRaises(TimeoutError):self.proxy.start()
  name=self.proxy.row['name'];self.volumes[name]['Labels']['abyssus.egress']='other'
  with self.assertRaises(Exception):self.proxy.recover()
  self.assertIn(name,self.volumes)
  self.volumes[name]['Labels']['abyssus.egress']=self.proxy.row['token'];self.in_use=True
  with self.assertRaisesRegex(RuntimeError,'still in use'):self.proxy.recover()
  self.assertIn(name,self.volumes)
  self.assertFalse(any('--force' in c for c in self.calls))
 def test_new_instance_recovers_retained_intent_without_creation_replay(self):
  with self.assertRaises(TimeoutError):self.proxy.start()
  replacement=SocketEgress(self.docker);replacement.recover()
  self.assertFalse(self.volumes);self.assertEqual(sum(c[:2]==['volume','create'] for c in self.calls),1)
 def test_removed_effect_lost_reply_is_reconciled_by_new_instance_without_remove_replay(self):
  with self.assertRaises(TimeoutError):self.proxy.start()
  self.lose_remove_reply=True
  with self.assertRaisesRegex(TimeoutError,'removal reply'):self.proxy.recover()
  self.assertFalse(self.volumes)
  retained=json.loads(self.docker.resources.db.execute('SELECT data FROM egress_volumes').fetchone()[0]);self.assertNotEqual(retained['phase'],'removed')
  replacement=SocketEgress(self.docker);replacement.recover()
  self.assertEqual(sum(c[:2]==['volume','rm'] for c in self.calls),1)
  retained=json.loads(self.docker.resources.db.execute('SELECT data FROM egress_volumes').fetchone()[0]);self.assertEqual(retained['phase'],'removed')
 def test_changed_recorded_creation_or_mountpoint_refuses_cleanup_on_restart(self):
  with self.assertRaises(TimeoutError):self.proxy.start()
  row=self.proxy.row;original=dict(self.volumes[row['name']]);row.update(createdAt=original['CreatedAt'],mountpoint=original['Mountpoint'],phase='created');self.proxy.save(row)
  for field in ['CreatedAt','Mountpoint']:
   self.volumes[row['name']][field]='changed'
   with self.assertRaises(Exception):SocketEgress(self.docker).recover()
   self.assertIn(row['name'],self.volumes);self.volumes[row['name']][field]=original[field]
  self.assertFalse(any(c[:2]==['volume','rm'] for c in self.calls))

if __name__=='__main__':unittest.main()
