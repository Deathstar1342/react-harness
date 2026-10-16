import copy
import json
from pathlib import Path
import sys
import unittest
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'containers/broker'))
from project_identity import ProjectIdentity
from protocol import Denied

class Mapping(unittest.TestCase):
    def setUp(self):
        self.binding={'storageId':str(uuid.uuid4()),'launchId':str(uuid.uuid4()),'engineId':'engine','context':'desktop-linux','controllerImage':'sha256:'+'a'*64,'probeImage':'sha256:'+'b'*64}
        self.project=str(uuid.uuid4());self.session=str(uuid.uuid4());self.calls=0;self.removed=0;self.bad=None
        owner=self
        class Docker:
            storage=Path('/selected');uid=1000;gid=1000
            def verify_engine(self):pass
            def storage_barrier(self):pass
            def create(self,args,image,kind):
                owner.args=args;owner.calls+=1
                if owner.bad=='lost-create':raise TimeoutError()
                return 'c'*64
            def find(self,container):return container
            def verify(self,row):return copy.deepcopy(owner.info)
            def remove(self,container):
                owner.removed+=1
                if owner.bad=='lost-cleanup':raise TimeoutError()
            def call(self,args,timeout,input):
                value={**json.loads(input),'workspace':{'dev':'5','ino':'1'},'identity':{'dev':'5','ino':'2'}}
                if owner.bad=='nonce':value['nonce']='0'*64
                if owner.bad=='extra':value['extra']=True
                if owner.bad=='workspace':value['workspace']['ino']='99'
                if owner.bad=='identity':value['identity']['ino']=True
                if owner.bad=='version':value['version']=True
                if owner.bad=='session':value['sessionId']=str(uuid.uuid4())
                if owner.bad=='lost-start':raise TimeoutError()
                return json.dumps(value)
        self.docker=Docker();self.docker.resources=self.docker
        self.info={'Config':{'User':'1000:1000','Entrypoint':['/usr/local/bin/node'],'Cmd':['/app/containers/project-identity-probe.mjs']},'HostConfig':{'NetworkMode':'none','ReadonlyRootfs':True,'Privileged':False,'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges'],'IpcMode':'private','PidsLimit':16,'Memory':134217728,'NanoCpus':1000000000,'Tmpfs':{'/tmp':'size=8m,mode=1777'},'Mounts':[{'Type':'bind','Source':str(self.docker.storage/'workspace'),'Target':'/workspace','ReadOnly':True}]},'Mounts':[{'Type':'bind','Destination':'/workspace','RW':False}],'State':{'Status':'exited','ExitCode':0}}
        self.probe=ProjectIdentity(self.docker,self.binding,self.session,{'dev':'5','ino':'1'})
    def test_complete_workspace_only_and_stable_distinct_linux_identity(self):
        first=self.probe.observe(self.project);second=self.probe.observe(self.project)
        self.assertEqual(first,second);self.assertEqual(first['identity'],['5','2']);self.assertEqual(self.removed,2)
        self.assertIn('type=bind,src='+str(self.docker.storage/'workspace')+',dst=/workspace,readonly',self.args)
        self.assertNotIn(self.project,' '.join(self.args));self.assertNotIn('source',' '.join(self.args))
    def test_bad_binding_schema_or_lost_effect_never_retries(self):
        for bad in ('nonce','extra','workspace','identity','version','session','lost-create','lost-start','lost-cleanup'):
            with self.subTest(bad=bad):
                self.setUp();self.bad=bad
                with self.assertRaises((Denied,TimeoutError)):self.probe.observe(self.project)
                with self.assertRaisesRegex(Denied,'RECOVERY_REQUIRED'):self.probe.observe(self.project)
                self.assertEqual(self.calls,1)
    def test_changed_mount_namespace_or_command_refuses_before_start(self):
        changes=[lambda v:v['Mounts'].append({'Type':'bind','Destination':'/private','RW':False}),lambda v:v['Mounts'][0].update(RW=True),lambda v:v['HostConfig'].update(NetworkMode='bridge'),lambda v:v['HostConfig']['Mounts'][0].update(Source='/original'),lambda v:v['Config'].update(Cmd=['/workspace/evil.js'])]
        for change in changes:
            with self.subTest(change=change):
                self.setUp();change(self.info)
                with self.assertRaises(Denied):self.probe.observe(self.project)
                self.assertEqual(self.removed,0)
    def test_unvalidated_project_never_creates_probe(self):
        for project in ('../source','name',True):
            with self.assertRaises(Denied):self.probe.observe(project)
        self.assertEqual(self.calls,0)

if __name__=='__main__':unittest.main()
