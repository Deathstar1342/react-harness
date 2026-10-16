"""Actual NTFS/operator/phase/SQLite pipeline; engine and Linux probes are synthetic."""
import copy
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import socket
import socketserver
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'containers/broker'))

@unittest.skipUnless(os.name=='nt','Windows native pipeline fixture')
class Pipeline(unittest.TestCase):
    def setUp(self):
        from protocol import now
        self.root=Path(tempfile.mkdtemp(prefix='m31-pipeline-',dir=os.environ.get('M31_TEST_ROOT'))).resolve()
        self.launch={'storage':str(self.root),'mode':'initialize','storageId':str(uuid.uuid4()),'launchId':str(uuid.uuid4()),'context':'desktop-linux','engineId':'synthetic-engine','controllerImage':'sha256:'+'a'*64,'workerImage':'sha256:'+'b'*64,'runtimeDigest':'c'*64,'key':secrets.token_hex(32),'token':secrets.token_hex(32)}
        self.host=None;self.thread=None;self.calls=[];self.fault=None;fixture=self
        class Payload:
            source_digest='d'*64
            def __init__(self,*_):pass
            def close(self):pass
        class Engine:
            uid=1000;gid=1000;source_digest='d'*64;authority=None
            def __init__(self,storage,storage_id,source,context,engine_id,image):
                self.storage=storage;self.storage_id=storage_id;self.source=source;self.context=context;self.engine_id=engine_id;self.image=image;self.containers={};self.counter=0;self.contexts={};self.images={}
            def attach(self,guard):
                from resources import Resources
                self.guard=guard;self.resources=Resources(self)
            def verify_engine(self):pass
            def storage_barrier(self):
                if self.authority:self.authority()
                else:self.guard.verify()
            def activate_workers(self):
                self.resources.recover()
                class Egress:
                    def terminate(self):fixture.calls.append('egress-terminate')
                    def wait(self):fixture.calls.append('egress-wait')
                self.egress=Egress();fixture.calls.append('workers-active')
            def bind_project_mapping(self,*_):fixture.calls.append('mapping-bound')
            def close_engine(self):pass
            def call(self,args,timeout=30,input=None):
                from transfer_service import write_new
                self.storage_barrier()
                if args[:2]==['image','inspect']:return args[2]
                if args[0]=='create':
                    initialize=args[-1]=='containers/initialize-native.ts';phase='initialize' if initialize else 'controller';self.counter+=1;identifier=format(self.counter,'064x')
                    mounts=[]
                    for i,arg in enumerate(args):
                        if arg=='--mount':
                            parts=args[i+1].split(',');values=dict(p.split('=',1) for p in parts if '=' in p);mounts.append({'Source':values['src'],'Target':values['dst'],'ReadOnly':'readonly' in parts})
                    labels=dict(args[i+1].split('=',1) for i,a in enumerate(args) if a=='--label')
                    info={'Id':identifier,'Name':'/'+args[args.index('--name')+1],'Image':fixture.launch['controllerImage'],'Config':{'Labels':labels,'User':'1000:1000','Entrypoint':['/usr/local/bin/node'],'Cmd':['--import','tsx',args[-1]]},'HostConfig':{'NetworkMode':'bridge','ReadonlyRootfs':True,'Privileged':False,'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges'],'IpcMode':'private','Init':True,'PidsLimit':128,'Memory':2147483648,'NanoCpus':2000000000,'Tmpfs':{'/tmp':'size=128m,mode=1777'},'Mounts':mounts,'PortBindings':{} if initialize else {'3000/tcp':[{'HostIp':'127.0.0.1','HostPort':''}]}},'Mounts':[{'Type':'bind','Destination':m['Target'],'RW':not m['ReadOnly']} for m in mounts],'State':{'Running':False,'Status':'created','ExitCode':0},'NetworkSettings':{'Ports':{'3000/tcp':[{'HostIp':'127.0.0.1','HostPort':'32123'}]}}}
                    self.containers[identifier]=info;fixture.calls.append('create-'+phase)
                    if fixture.fault=='create-'+phase:raise TimeoutError('lost create reply')
                    return identifier
                if args[0]=='inspect':return json.dumps([self.containers[args[1]]])
                if args[0]=='ps':
                    selector=args[args.index('--filter')+1]
                    return '\n'.join(k for k,v in self.containers.items() if selector=='id='+k or selector=='name=^'+v['Name']+'$')
                if args[0]=='rm':
                    fixture.calls.append('remove');del self.containers[args[-1]];return ''
                if args[0]=='start':
                    info=self.containers[args[-1]];initialize=info['Config']['Cmd'][-1]=='containers/initialize-native.ts';phase='initialize' if initialize else 'controller'
                    fixture.calls.append('start-'+phase);info['State']={'Running':not initialize,'Status':'exited' if initialize else 'running','ExitCode':0}
                    if fixture.fault=='start-'+phase:raise TimeoutError('lost start reply')
                    fixture.redeem()
                    if initialize:write_new(self.storage/'state/container-storage.json',{'version':1,'storageId':self.storage_id,'profileId':str(uuid.uuid4()),'kind':'local-bind'})
                    else:
                        identity={'instanceId':str(uuid.uuid4()),'profileId':str(uuid.uuid4()),'platform':'linux','state':'ready'}
                        if fixture.fault=='readiness':identity['platform']='win32'
                        write_new(self.storage/'state/backend.json',{'version':1,'key':fixture.launch['key'],'identity':identity})
                    return ''
                raise AssertionError(args)
        def route(docker,image,session,retained=None):
            from route_probe import LocalServer
            server=retained or LocalServer(('127.0.0.1',0),socketserver.StreamRequestHandler);port=server.server_address[1];issued=now()
            server.route={'connectIP':'127.0.0.1','bind':'127.0.0.1','connect':'127.0.0.1','adapterId':None,'port':port,'sessionId':session,'proof':{'version':1,'nonce':secrets.token_hex(32),'engineId':self.launch['engineId'],'probeImage':image,'address':'127.0.0.1','bindAddress':'127.0.0.1','port':port,'sessionId':session,'issuedAt':issued,'expiresAt':issued+30000}}
            return server
        def probe(*_):return lambda challenge:{**challenge,'slots':{name:{'dev':'5','ino':str(i)} for i,name in enumerate(('state','config','workspace','control'),1)},'sqlite':{'wal':True,'secondWriterDenied':True,'reopened':True}}
        self.patches=[patch('windows_supervisor.NativePayload',Payload),patch('windows_supervisor.WindowsEngine',Engine),patch('native_phase.prove_server',side_effect=route),patch('native_phase.verify_route'),patch('native_phase.FixedStorageProbe',side_effect=probe)]
        for item in self.patches:item.start()
    def make(self):
        from windows_supervisor import WindowsSupervisor
        self.host=WindowsSupervisor(self.launch,Path(__file__).resolve().parents[1]);return self.host
    def redeem(self):
        from protocol import PROTOCOL,canonical,now,mac,decode
        control=self.root/'runtime/control';record=json.loads((control/'session.json').read_text());policy=json.loads((control/'native-bind.json').read_text())
        envelope={'protocol':PROTOCOL,'sessionId':record['sessionId'],'nonce':secrets.token_hex(32),'expiresAt':now()+30000,'op':'redeem_storage','body':{'proofId':policy['proofId']}}
        with socket.create_connection((record['host'],record['port']),timeout=3) as peer:
            peer.sendall((canonical({**envelope,'mac':mac(envelope,record['key'])})+'\n').encode())
            with peer.makefile('rb') as stream:reply=decode(stream.readline(16385))
        self.assertTrue(reply['ok'],reply)
    def stop_controller(self):
        from transfer_service import private_json
        from windows_handles import remove_owned_record
        self.host.docker.containers[self.host.owner['container']]['State']={'Running':False,'Status':'exited','ExitCode':0}
        file=self.root/'state/backend.json';remove_owned_record(file,private_json(file))
        unsigned={'version':1,'instanceId':self.host.owner['instanceId'],'profileId':self.host.owner['profileId'],'state':'stopped'}
        from transfer_service import write_new
        write_new(file,{**unsigned,'mac':hmac.new(self.launch['key'].encode(),json.dumps(unsigned,separators=(',',':')).encode(),hashlib.sha256).hexdigest()})
    def tearDown(self):
        if self.host:
            phase=self.host.phase
            if phase:
                if phase.thread:
                    try:phase.revoke()
                    except Exception:phase.server.shutdown();phase.thread.join(timeout=3)
                if phase.server:phase.server.server_close()
                if phase.journal:phase.journal.db.close()
            operator=self.host.operator
            if operator and not operator.closed:
                if self.thread:operator.failure=True;operator.server.shutdown();self.thread.join(timeout=3)
                else:operator.server.server_close();operator.db.close();operator.stack.close()
            if self.host.journal:
                self.host.journal.db.close();self.host.docker.resources.db.close()
            self.host.close_handles()
        for item in reversed(self.patches):item.stop()
    def test_native_pipeline_readiness_authenticated_reconnect_and_verified_drain(self):
        from native_operator import descriptor,request,wait_drained
        host=self.make();ready=host.start();self.assertFalse(ready['reconnect']);self.assertTrue((self.root/'.storage-id').exists())
        self.assertEqual(self.calls[:6],['create-initialize','start-initialize','remove','workers-active','mapping-bound','create-controller'])
        record=descriptor(self.root,host.operator.binding,host.guard);self.thread=threading.Thread(target=host.serve,daemon=True);self.thread.start()
        self.assertEqual(request(record,{'op':'status'}),{**ready,'reconnect':True});self.assertEqual(request(record,{'op':'stopped'}),{'stopped':False})
        self.stop_controller();self.assertEqual(request(record,{'op':'stopped'}),{'stopped':True})
        self.assertEqual(request(record,{'op':'drain'}),{'stopped':True})
        # Client has independent native pins, just as a reconnected relay does.
        from windows_handles import NativeStorageGuard
        with NativeStorageGuard(self.root) as guard:self.assertEqual(wait_drained(self.root,record,guard),{'stopped':True})
        self.thread.join(timeout=3);self.assertFalse(self.thread.is_alive());self.assertFalse(host.docker.containers)
        self.assertFalse((self.root/'runtime/control/session.json').exists())
    def test_relay_reconnect_checks_binding_and_drain_before_a_new_lifecycle(self):
        from windows_client import WindowsDesktopHost
        host=self.make();ready=host.start();self.thread=threading.Thread(target=host.serve,daemon=True);self.thread.start()
        class Payload:
            source_digest='d'*64
            def __init__(self,*_):pass
            def close(self):pass
        launch={**self.launch,'mode':'existing','launchId':str(uuid.uuid4()),'key':secrets.token_hex(32),'token':secrets.token_hex(32)}
        with patch('windows_client.NativePayload',Payload),patch('windows_client.subprocess.Popen') as spawn:
            relay=WindowsDesktopHost(launch)
            try:
                self.assertEqual(relay.start(),{**ready,'reconnect':True});spawn.assert_not_called()
                wrong=WindowsDesktopHost({**launch,'workerImage':'sha256:'+'e'*64})
                try:
                    with self.assertRaisesRegex(Exception,'BINDING_CHANGED'):wrong.start()
                finally:wrong.close()
                spawn.assert_not_called();self.stop_controller();self.assertEqual(relay.dispatch({'op':'drain'}),{'stopped':True})
                self.thread.join(timeout=3);self.assertFalse(self.thread.is_alive())
            finally:relay.close()
            # Clean verified drain permits staged image changes for a new launch;
            # the fixture stops at the spawn boundary, so no process is started.
            spawn.side_effect=RuntimeError('new lifecycle boundary')
            fresh=WindowsDesktopHost({**launch,'workerImage':'sha256:'+'e'*64})
            try:
                with self.assertRaisesRegex(RuntimeError,'new lifecycle boundary'):fresh.start()
                spawn.assert_called_once()
            finally:fresh.close()
    def test_lost_controller_create_reply_retains_intent_and_never_restarts(self):
        host=self.make();self.fault='create-controller'
        with self.assertRaises(TimeoutError):host.start()
        before=list(self.calls)
        with self.assertRaisesRegex(Exception,'RECOVERY_REQUIRED'):host.start()
        self.assertEqual(self.calls,before);self.assertEqual(host.operator.record['phase'],'intent');self.assertEqual(host.owner['phase'],'create-intent')
        rows=[json.loads(row[0]) for row in host.docker.resources.db.execute('SELECT data FROM resources')]
        self.assertEqual(rows[-1]['phase'],'intent');self.assertEqual(len(host.docker.containers),1)
    def test_lost_initializer_start_refuses_root_commit_and_controller(self):
        host=self.make();self.fault='start-initialize'
        with self.assertRaises(TimeoutError):host.start()
        self.assertFalse((self.root/'.storage-id').exists());self.assertNotIn('workers-active',self.calls);self.assertEqual(len(host.docker.containers),1)
        with self.assertRaisesRegex(Exception,'RECOVERY_REQUIRED'):host.start()
    def test_lost_controller_start_preserves_start_intent(self):
        host=self.make();self.fault='start-controller'
        with self.assertRaises(TimeoutError):host.start()
        self.assertEqual(host.owner['phase'],'start-intent');self.assertEqual(host.operator.record['phase'],'intent')
        with self.assertRaisesRegex(Exception,'RECOVERY_REQUIRED'):host.start()
    def test_untrusted_ready_identity_never_activates_operator(self):
        host=self.make();self.fault='readiness'
        with self.assertRaisesRegex(Exception,'IDENTITY_CHANGED'):host.start()
        self.assertEqual(host.operator.record['phase'],'intent');self.assertTrue(host.failed)
    def test_actual_mounts_require_each_exact_destination_once(self):
        host=self.make();host.start();info=host.docker.containers[host.owner['container']];original=copy.deepcopy(info['Mounts'])
        info['Mounts'][1]=copy.deepcopy(info['Mounts'][0])
        with self.assertRaisesRegex(Exception,'MOUNTS'):host.owned(host.owner['container'])
        info['Mounts']=original;info['HostConfig']['Mounts'][0]['Source']=str(self.root.parent)
        with self.assertRaisesRegex(Exception,'SOURCE_CHANGED'):host.owned(host.owner['container'])

if __name__=='__main__':unittest.main()
