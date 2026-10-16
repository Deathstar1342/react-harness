"""Retained Windows host supervisor. Only trusted native main supplies launch/pickers."""
import hashlib
import hmac
import json
from pathlib import Path
import re
import secrets
import time
import uuid
from protocol import exact,require,UUID,HEX,canonical,Journal
from windows_handles import PinnedPath,NativeStorageGuard,operator_record_lock,remove_owned_record
from windows_scaffold import WindowsScaffold,verify_committed_scaffold
from windows_engine import WindowsEngine
from native_payload import NativePayload
from native_phase import NativePhase
from native_operator import NativeOperator
from transfer_service import private_json,select,authorize,area
from server import Broker

LAUNCH=('storage','mode','storageId','context','engineId','controllerImage','workerImage','key','token','launchId','runtimeDigest')


def validate_launch(value):
    exact(value,LAUNCH)
    for name in ('storageId','launchId'):require(type(value[name]) is str and UUID.fullmatch(value[name]),'INVALID_NATIVE_LAUNCH')
    for name in ('key','token','runtimeDigest'):require(type(value[name]) is str and HEX.fullmatch(value[name]),'INVALID_NATIVE_LAUNCH')
    for name in ('controllerImage','workerImage'):require(type(value[name]) is str and re.fullmatch('sha256:[a-f0-9]{64}',value[name]),'INVALID_NATIVE_LAUNCH')
    require(value['mode'] in ('initialize','existing') and type(value['storage']) is str and ',' not in value['storage'],'INVALID_NATIVE_LAUNCH')
    require(type(value['engineId']) is str and re.fullmatch('[!-~]{1,256}',value['engineId']) and type(value['context']) is str and re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}',value['context']),'INVALID_NATIVE_LAUNCH')


class WindowsSupervisor:
    def __init__(self,launch,source):
        validate_launch(launch);self.launch=dict(launch);self.storage=Path(launch['storage']);self.source=Path(source)
        require(self.storage!=Path.home() and self.storage!=self.source and self.storage not in self.source.parents and self.source not in self.storage.parents,'UNSAFE_NATIVE_STORAGE')
        self.payload=NativePayload(self.source,launch['runtimeDigest']);self.guard=None;self.operator=None;self.docker=None;self.phase=None;self.scaffold=None;self.journal=None;self.broker=None;self.owner=None;self.ready=None;self.pending={};self.start_attempted=False;self.failed=False;self.handles_closed=False
        try:
            if launch['mode']=='initialize':
                self.scaffold=WindowsScaffold(self.storage,launch['storageId'],launch['launchId']);self.guard=self.scaffold.begin()
            else:
                verify_committed_scaffold(self.storage,launch['storageId']);self.guard=NativeStorageGuard(self.storage);self.guard.verify()
            binding={key:launch[key] for key in ('storageId','engineId','context','controllerImage','workerImage','runtimeDigest','launchId')};binding['sourceDigest']=self.payload.source_digest
            # Lease and durable inactive operator intent precede any Docker effect.
            self.operator=NativeOperator(self.storage,binding,self.guard,self.dispatch)
            self.docker=WindowsEngine(self.storage,launch['storageId'],self.source,launch['context'],launch['engineId'],launch['workerImage']);self.docker.attach(self.guard)
            require(self.docker.source_digest==self.payload.source_digest,'NATIVE_SOURCE_CHANGED')
            require(self.docker.call(['image','inspect',launch['controllerImage'],'--format','{{.Id}}']).strip()==launch['controllerImage'],'CONTROLLER_IMAGE_CHANGED')
            self.phase=NativePhase(self.docker,launch,self.guard)
        except BaseException:
            # No retry/guessed resource cleanup after interrupted initialization.
            self.close_handles();raise
    def save_owner(self,value):
        with operator_record_lock(self.operator.area),self.operator.db:
            self.operator.db.execute('CREATE TABLE IF NOT EXISTS controller_owner(id INTEGER PRIMARY KEY,data TEXT NOT NULL)')
            self.operator.db.execute('INSERT INTO controller_owner VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',(canonical(value),))
        self.owner=value
    def mounts(self,initialize=False):
        return [(self.storage/source,target,readonly) for source,target,readonly in [('state','/initialize/state' if initialize else '/abyssus',False),('config','/initialize/config' if initialize else '/abyssus/profile/config',False),('workspace','/initialize/workspace' if initialize else '/workspace',False),('runtime/control','/run/abyssus-broker',True)]]
    def args(self,digest,initialize=False):
        args=['--network','bridge','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','2g','--cpus','2','--user','1000:1000','--init','--tmpfs','/tmp:size=128m,mode=1777','-e','HARNESS_EXECUTION_MODE=container','-e','HARNESS_STORAGE_ID='+self.launch['storageId'],'-e','HARNESS_LAUNCH_ID='+self.launch['launchId'],'-e','HARNESS_NATIVE_BIND_DIGEST='+digest]
        if not initialize:args+=['-e','HARNESS_DESKTOP=1','-p','127.0.0.1::3000']
        for source,target,readonly in self.mounts(initialize):args+=['--mount',f'type=bind,src={source},dst={target}'+(',readonly' if readonly else '')]
        args+=['--entrypoint','/usr/local/bin/node',self.launch['controllerImage'],'--import','tsx','containers/initialize-native.ts' if initialize else 'containers/controller.ts']
        return args
    def owned(self,container,initialize=False):
        info=self.docker.resources.verify(self.docker.resources.find(container));config=info['HostConfig'];selected={(str(source),target,readonly) for source,target,readonly in self.mounts(initialize)}
        require(info['Image']==self.launch['controllerImage'] and info['Config']['User']=='1000:1000' and info['Config']['Entrypoint']==['/usr/local/bin/node'] and info['Config']['Cmd']==['--import','tsx','containers/initialize-native.ts' if initialize else 'containers/controller.ts'],'CONTROLLER_IDENTITY_CHANGED')
        require(config['NetworkMode']=='bridge' and config['ReadonlyRootfs'] and not config['Privileged'] and config['CapDrop']==['ALL'] and config['SecurityOpt']==['no-new-privileges'],'UNSAFE_NATIVE_CONTROLLER')
        require(not any(config.get(key) for key in ('CapAdd','Devices','DeviceRequests','Binds','VolumesFrom','PidMode','UTSMode')) and config.get('IpcMode')=='private','UNSAFE_NATIVE_CONTROLLER')
        require(config.get('Init') is True and config.get('PidsLimit')==128 and config.get('Memory')==2147483648 and config.get('NanoCpus')==2000000000 and config.get('Tmpfs')=={'/tmp':'size=128m,mode=1777'},'UNSAFE_NATIVE_CONTROLLER')
        require({(m['Source'],m['Target'],m.get('ReadOnly',False)) for m in config.get('Mounts',[])}==selected and len(config.get('Mounts',[]))==4,'NATIVE_CONTROLLER_SOURCE_CHANGED')
        targets={target:readonly for source,target,readonly in self.mounts(initialize)}
        require(len(info['Mounts'])==4 and {m['Destination'] for m in info['Mounts']}==set(targets) and all(m['Type']=='bind' and m['Destination'] in targets and m['RW']==(not targets[m['Destination']]) for m in info['Mounts']),'UNSAFE_NATIVE_CONTROLLER_MOUNTS')
        ports=config.get('PortBindings') or {}
        if initialize:require(not ports,'INITIALIZER_PORT_REFUSED')
        else:require(set(ports)=={'3000/tcp'} and len(ports['3000/tcp'])==1 and ports['3000/tcp'][0]['HostIp']=='127.0.0.1','UNSAFE_NATIVE_CONTROLLER_PORT')
        return info
    def start(self):
        require(not self.start_attempted and not self.failed,'NATIVE_START_RECOVERY_REQUIRED');self.start_attempted=True
        try:return self._start()
        except BaseException:
            self.failed=True
            # Preserve every effect intent. A lost reply never retries startup or
            # activates the operator; recovery must inspect exact owned resources.
            if self.operator:self.operator.failure=True
            raise
    def _start(self):
        if self.scaffold:
            self.scaffold.profile_started();digest,_,_=self.phase.activate('initialize')
            container=self.docker.resources.create(self.args(digest,True),self.launch['controllerImage'],'controller')
            self.owned(container,True);self.docker.call(['start','--attach',container],timeout=120)
            info=self.owned(container,True);require(info['State']['Status']=='exited' and info['State']['ExitCode']==0 and self.phase.session.mapping is not None,'NATIVE_INITIALIZATION_UNCERTAIN')
            self.docker.resources.remove(container);self.phase.revoke();self.scaffold.finish()
        # Image export/egress setup precedes short-lived controller route proofs.
        self.docker.activate_workers();session_id=str(uuid.uuid4());database=self.storage/'runtime/worker-journal.sqlite'
        if not database.exists():
            with PinnedPath(database,write=True,create=True,directory=False) as pin:pin.private()
        self.journal=Journal(str(database),session_id);self.broker=Broker(self.journal,self.docker);area(self.storage);self.broker.transfers.verify_journal()
        self.phase.publish('desktop-launch.json',{'version':1,**{key:self.launch[key] for key in ('storageId','launchId','key','token')}})
        digest,session_id,slots=self.phase.activate('controller',self.worker_dispatch,session_id)
        self.docker.bind_project_mapping(self.phase.binding,session_id,slots['workspace']);self.docker.authority=self.phase.session.fresh
        self.save_owner({'phase':'create-intent','container':None,'launchId':self.launch['launchId'],'image':self.launch['controllerImage'],'instanceId':None,'profileId':None})
        container=self.docker.resources.create(self.args(digest),self.launch['controllerImage'],'controller');self.save_owner({**self.owner,'phase':'created','container':container})
        self.owned(container);self.save_owner({**self.owner,'phase':'start-intent'});self.docker.call(['start',container]);self.save_owner({**self.owner,'phase':'running'})
        end=time.monotonic()+45
        while True:
            self.guard.verify();info=self.owned(container);require(info['State']['Running'],'NATIVE_CONTROLLER_EXITED')
            try:
                value=private_json(self.storage/'state/backend.json',4096)
                if value.get('key')==self.launch['key'] and value.get('identity',{}).get('state')=='ready':break
            except FileNotFoundError:pass
            require(time.monotonic()<end,'NATIVE_CONTROLLER_NOT_READY');time.sleep(.1)
        identity=value['identity'];require(UUID.fullmatch(identity['instanceId']) and UUID.fullmatch(identity['profileId']) and identity['platform']=='linux','NATIVE_CONTROLLER_IDENTITY_CHANGED')
        self.save_owner({**self.owner,'instanceId':identity['instanceId'],'profileId':identity['profileId']})
        ports=info['NetworkSettings']['Ports']['3000/tcp'];require(len(ports)==1 and ports[0]['HostIp']=='127.0.0.1' and ports[0]['HostPort'].isdigit(),'UNSAFE_NATIVE_ENDPOINT')
        self.ready={'address':'http://127.0.0.1:'+ports[0]['HostPort'],'identity':identity,'checks':[],'reconnect':False,'key':self.launch['key'],'token':self.launch['token']}
        self.operator.activate();return self.ready
    def worker_dispatch(self,op,body):
        if op=='shutdown':exact(body,[]);self.broker.shutdown();return {'stopped':True}
        return self.broker.dispatch(op,body)
    def stopped(self):
        info=self.owned(self.owner['container'])
        if info['State']['Running']:return False
        require(info['State']['Status']=='exited' and info['State']['ExitCode']==0,'NATIVE_CONTROLLER_EXIT_UNCERTAIN')
        value=private_json(self.storage/'state/backend.json',4096);exact(value,['version','instanceId','profileId','state','mac'])
        unsigned={key:value[key] for key in ('version','instanceId','profileId','state')}
        expected=hmac.new(self.launch['key'].encode(),json.dumps(unsigned,separators=(',',':')).encode(),hashlib.sha256).hexdigest()
        require(type(value['version']) is int and value['version']==1 and value['instanceId']==self.owner['instanceId'] and value['profileId']==self.owner['profileId'] and value['state']=='stopped' and hmac.compare_digest(value['mac'],expected),'NATIVE_STOP_RECEIPT_CHANGED')
        return True
    def dispatch(self,request):
        op=request['op']
        if op=='status':require(self.ready is not None,'NATIVE_NOT_READY');self.owned(self.owner['container']);return {**self.ready,'reconnect':True}
        if op=='stopped':return {'stopped':self.stopped()}
        if op=='drain':
            require(self.stopped(),'NATIVE_CONTROLLER_NOT_DRAINED');self.broker.shutdown();self.docker.egress.terminate();self.docker.egress.wait()
            self.docker.resources.remove(self.owner['container']);self.phase.revoke();self.phase.close_socket();self.docker.authority=None
            descriptor=private_json(self.storage/'runtime/control/session.json',2048);require(descriptor['sessionId']==self.journal.session,'NATIVE_SESSION_CHANGED');remove_owned_record(self.storage/'runtime/control/session.json',descriptor)
            self.save_owner({**self.owner,'phase':'drained'});self.journal.db.close();self.journal=None;self.docker.resources.db.close();return {'stopped':True}
        if op=='transfer-select':
            require(len(self.pending)<16 and self.owned(self.owner['container'])['State']['Running'],'NATIVE_SELECTION_REFUSED')
            token,ticket=select(self.storage,self.launch['storageId'],self.source,request['kind'],request['path'],request['project'],request['included'],request['history'])
            handle=secrets.token_hex(32);self.pending[handle]=(token,ticket);manifest=ticket['manifest']
            return {'handle':handle,'files':len(manifest['entries']),'bytes':manifest['bytes'],'excluded':manifest['excluded'][:100],'excludedCount':len(manifest['excluded']),'history':manifest['history']}
        if op=='transfer-authorize':
            require(request['handle'] in self.pending,'NATIVE_SELECTION_EXPIRED');token,ticket=self.pending.pop(request['handle']);self.docker.storage_barrier();authorize(self.storage,token,ticket);return {'code':token}
        if op=='transfer-discard':self.pending.pop(request['handle'],None);return {'discarded':True}
        raise ValueError('NATIVE_OPERATOR_REFUSED')
    def serve(self):
        try:self.operator.serve()
        finally:self.close_handles()
    def close_handles(self):
        if self.handles_closed:return
        self.handles_closed=True
        # Closing pins is not an assertion of resource cleanup. Durable uncertain
        # owner/phase records prevent replay after any failure here.
        if self.docker:self.docker.close_engine()
        if self.guard:self.guard.close()
        self.payload.close()
