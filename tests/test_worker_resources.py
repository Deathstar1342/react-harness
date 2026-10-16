import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parents[1]/'containers/broker'))
from resources import Resources
from protocol import Denied

class Engine:
    def __init__(self,root):
        self.storage=Path(root);(self.storage/'runtime').mkdir()
        self.storage_id='fixture';self.items={};self.calls=[];self.offline=False;self.lose_create=False
    def call(self,args):
        self.calls.append(args)
        if self.offline:raise Denied('ENGINE_OPERATION_FAILED')
        if args[0]=='create':
            id=('%064x'%(len(self.items)+1));name=args[args.index('--name')+1]
            labels={}
            for i,v in enumerate(args):
                if v=='--label':key,value=args[i+1].split('=',1);labels[key]=value
            self.items[id]={'Id':id,'Name':'/'+name,'Image':args[-1],'Config':{'Labels':labels},'State':{'Running':True}}
            if self.lose_create:raise Denied('ENGINE_REPLY_LOST')
            return id
        if args[0]=='ps':
            selector=args[args.index('--filter')+1]
            return '\n'.join(id for id,v in self.items.items() if selector=='id='+id or selector=='name=^'+v['Name']+'$')
        if args[0]=='inspect':return json.dumps([self.items[args[1]]])
        if args[0]=='rm':self.items.pop(args[-1]);return args[-1]
        if args[0]=='stop':self.items[args[-1]]['State']['Running']=False;return args[-1]
        raise AssertionError(args)

class Ownership(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.engine=Engine(self.tmp.name);self.resources=Resources(self.engine)
    def tearDown(self):self.resources.db.close();self.tmp.cleanup()
    def test_lost_create_reply_keeps_durable_intent_and_restart_only_cleans(self):
        self.engine.lose_create=True
        with self.assertRaises(Denied):self.resources.create(['image'],'image','worker')
        self.resources.db.close();self.resources=Resources(self.engine);self.resources.recover()
        self.assertEqual(self.engine.items,{})
        self.assertFalse(any(c[0] in ('start','exec') for c in self.engine.calls))
    def test_offline_engine_is_not_confirmed_absence_and_ownership_is_retained(self):
        id=self.resources.create(['image'],'image','worker');self.engine.offline=True
        with self.assertRaises(Denied):self.resources.remove(id)
        self.assertEqual(self.resources.find(id)['phase'],'created')
        self.engine.offline=False;self.resources.remove(id);self.assertEqual(self.resources.find(id)['phase'],'removed')
    def test_stop_accepts_confirmed_previously_removed_companion_but_not_offline_engine(self):
        id=self.resources.create(['image'],'image','companion');self.resources.remove(id)
        self.assertFalse(self.resources.stop(id))
        self.engine.offline=True
        with self.assertRaises(Denied):self.resources.stop(id)
    def test_changed_identity_never_removes_foreign_container(self):
        id=self.resources.create(['image'],'image','worker');self.engine.items[id]['Config']['Labels']['abyssus.owner']='foreign'
        with self.assertRaisesRegex(Denied,'IDENTITY'):self.resources.remove(id)
        self.assertIn(id,self.engine.items)
    def test_restart_stops_maintenance_and_keeps_layer_without_replay(self):
        id=self.resources.create(['image'],'image','maintenance');self.resources.recover()
        self.assertFalse(self.engine.items[id]['State']['Running'])
        self.assertEqual(self.resources.find(id)['phase'],'retained-stopped')
        self.assertFalse(any(c[0] in ('start','exec') for c in self.engine.calls))
    def test_failed_recovery_attempts_other_owned_scopes(self):
        one=self.resources.create(['image'],'image','worker');two=self.resources.create(['image'],'image','worker')
        self.engine.items[one]['Config']['Labels']['abyssus.owner']='foreign'
        with self.assertRaisesRegex(Denied,'RECOVERY'):self.resources.recover()
        self.assertIn(one,self.engine.items);self.assertNotIn(two,self.engine.items)

if __name__=='__main__':unittest.main()
