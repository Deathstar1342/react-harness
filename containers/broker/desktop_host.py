"""Private Electron child supervisor. No renderer/model command endpoint.

The only path-bearing requests arrive over its parent-owned anonymous stdin pipe.
Durable resource intent precedes Docker create; reconnect never repeats a create.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import subprocess
import sys
import time
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parent))
from protocol import require, exact, canonical, Denied
from transfer_service import private_json, write_new, select, authorize
from source import request as broker_request

SHA = re.compile(r'sha256:[a-f0-9]{64}\Z')
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z')

class DesktopHost:
    def __init__(self, launch):
        exact(launch, ['storage','mode','storageId','context','engineId','controllerImage','workerImage','key','token','launchId'])
        require(sys.platform == 'linux', 'PLATFORM_ADAPTER_REQUIRED')
        require(os.getuid() > 0 and os.getgid() > 0, 'NONROOT_HOST_REQUIRED')
        for key in ('storageId','launchId'): require(type(launch[key]) is str and UUID.fullmatch(launch[key]), 'INVALID_LAUNCH')
        for key in ('key','token'): require(type(launch[key]) is str and re.fullmatch('[a-f0-9]{64}',launch[key]), 'INVALID_LAUNCH')
        for key in ('controllerImage','workerImage'): require(type(launch[key]) is str and SHA.fullmatch(launch[key]), 'INVALID_IMAGE')
        require(type(launch['context']) is str and re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}',launch['context']), 'INVALID_ENGINE')
        require(launch['mode'] in ('existing','initialize'), 'INVALID_LAUNCH')
        self.launch=launch
        self.storage=Path(launch['storage'])
        self.source=Path(__file__).resolve().parents[2]
        require(self.storage.is_absolute() and self.storage.resolve()==self.storage and ',' not in str(self.storage) and not any(ord(c)<32 for c in str(self.storage)), 'UNSAFE_STORAGE')
        require(self.storage!=Path.home() and self.storage!=Path('/') and self.storage not in self.source.parents and self.source not in self.storage.parents and self.storage!=self.source, 'UNSAFE_STORAGE')
        self.source_digest=hashlib.sha256(b''.join(file.name.encode()+b'\0'+file.read_bytes() for file in sorted((self.source/'containers/broker').glob('*.py')))).hexdigest()
        self.env={k:os.environ[k] for k in ('PATH','HOME','LANG','TMPDIR') if k in os.environ}
        self.env['LANG']='C.UTF-8'
        self.owner=None;self.lease=None;self.broker=None;self.pending={}
        self.engine()
        for image in ('controllerImage','workerImage'):
            require(self.call(['image','inspect',launch[image],'--format','{{.Id}}']).strip()==launch[image], 'RUNTIME_IMAGE_MISSING')
        require(self.call(['image','inspect','abyssus-worker:m29','--format','{{.Id}}']).strip()==launch['workerImage'], 'WORKER_IMAGE_CHANGED')

    def call(self,args,timeout=30):
        p=subprocess.run(['docker','--context',self.launch['context'],*args],env=self.env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
        require(p.returncode==0 and len(p.stdout)<=2*1024*1024, 'ENGINE_OPERATION_FAILED')
        return p.stdout.decode('utf8')

    def engine(self):
        endpoint=self.call(['context','inspect',self.launch['context'],'--format','{{.Endpoints.docker.Host}}']).strip()
        require(endpoint.startswith('unix:///') and Path(endpoint[7:]).is_socket(), 'LOCAL_ENGINE_REQUIRED')
        info=json.loads(self.call(['info','--format','{{json .}}']))
        require(info['ID']==self.launch['engineId'] and info['OSType']=='linux' and info['Architecture'] in ('amd64','x86_64'), 'ENGINE_CHANGED')
        require(not any('rootless' in v or 'userns' in v for v in info.get('SecurityOptions',[])), 'UNSUPPORTED_UID_MAPPING')

    def save(self,value):
        file=self.storage/'runtime/desktop-owner.json'
        temporary=file.with_name('desktop-owner-'+secrets.token_hex(16)+'.pending')
        write_new(temporary,value);temporary.replace(file)
        fd=os.open(file.parent,os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
        self.owner=value

    def owned(self):
        require(self.owner is not None,'NO_OWNERSHIP')
        values=self.call(['ps','-a','--no-trunc','--filter','name=^/'+self.owner['name']+'$','--format','{{.ID}}']).splitlines()
        require(len(values)<=1,'OWNERSHIP_CHANGED')
        if not values:return None
        require(re.fullmatch('[a-f0-9]{64}',values[0]) and (self.owner['id'] is None or self.owner['id']==values[0]),'OWNERSHIP_CHANGED')
        info=json.loads(self.call(['inspect',values[0]]))[0]
        labels=info['Config'].get('Labels') or {}
        require(info['Id']==values[0] and info['Name']=='/'+self.owner['name'] and info['Image']==self.owner['image'] and labels.get('abyssus.desktop')==self.owner['owner'] and labels.get('abyssus.storage')==self.launch['storageId'],'OWNERSHIP_CHANGED')
        expected_mounts={str(self.storage/source):(target,readonly) for source,target,readonly in [('state','/abyssus',False),('config','/abyssus/profile/config',False),('workspace','/workspace',False),('runtime/control','/run/abyssus-broker',True)]}
        actual_mounts={m['Source']:(m['Destination'],not m['RW']) for m in info['Mounts'] if m['Type']=='bind'}
        require(len(info['Mounts'])==len(expected_mounts) and all(m['Type']=='bind' for m in info['Mounts']),'UNEXPECTED_MOUNT')
        config=info['HostConfig']
        require(not config.get('CapAdd') and not config.get('Devices') and not config.get('DeviceRequests') and not config.get('Binds') and not config.get('VolumesFrom') and not config.get('PidMode') and config.get('IpcMode')=='private' and not config.get('UTSMode') and config.get('Tmpfs')=={'/tmp':'size=128m,mode=1777'} and config.get('Init') is True and config.get('PidsLimit')==128 and config.get('Memory')==2147483648 and config.get('NanoCpus')==2000000000 and len(config['SecurityOpt'])==1,'UNSAFE_CONTROLLER_CONFIG')
        require(actual_mounts==expected_mounts,'CONTROLLER_MOUNTS_CHANGED')
        require(not config['Privileged'] and config['ReadonlyRootfs'],'CONTROLLER_PRIVILEGE_CHANGED')
        require(config['NetworkMode']=='bridge','CONTROLLER_NETWORK_CHANGED')
        require(config['CapDrop']==['ALL'],'CONTROLLER_CAPS_CHANGED')
        require('no-new-privileges' in config['SecurityOpt'],'CONTROLLER_SECURITY_CHANGED')
        require(info['Config']['User']==f'{os.getuid()}:{os.getgid()}','CONTROLLER_USER_CHANGED')
        ports=config['PortBindings']
        require(set(ports)=={'3000/tcp'} and len(ports['3000/tcp'])==1 and ports['3000/tcp'][0]['HostIp']=='127.0.0.1','UNSAFE_ENDPOINT')
        if self.owner['id'] is None:self.save({**self.owner,'id':values[0]})
        return info

    def storage_check(self):
        require(self.storage.is_dir() and not self.storage.is_symlink() and self.storage.stat().st_uid==os.getuid() and self.storage.stat().st_mode&0o077==0,'UNSAFE_STORAGE')
        require((self.storage/'.storage-id').read_text()==self.launch['storageId']+'\n','STORAGE_CHANGED')
        for name in ('state','config','workspace','runtime'):
            folder=self.storage/name
            require(folder.is_dir() and not folder.is_symlink() and folder.resolve()==folder and folder.stat().st_uid==os.getuid() and folder.stat().st_mode&0o077==0,'STORAGE_CHANGED')
        for name in ('state','config','workspace'):require((self.storage/name/'.storage-id').read_text()==self.launch['storageId']+'\n','STORAGE_CHANGED')

    def start(self):
        if self.launch['mode']=='initialize':
            require(self.storage.is_dir() and not self.storage.is_symlink() and not list(self.storage.iterdir()),'EMPTY_STORAGE_REQUIRED')
            self.storage.chmod(0o700)
            # A partial initialization is never retried automatically.
            self.call(['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user',f'{os.getuid()}:{os.getgid()}','--tmpfs','/tmp:size=32m,mode=1777','--mount',f'type=bind,src={self.storage},dst=/initialize','-e','HARNESS_STORAGE_ID='+self.launch['storageId'],self.launch['controllerImage'],'node','--import','tsx','containers/initialize.ts'],120)
        self.storage_check()
        lock=self.storage/'runtime/desktop-owner.sqlite'
        if not lock.exists():fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600);os.close(fd)
        require(not lock.is_symlink() and lock.stat().st_nlink==1,'UNSAFE_OWNERSHIP')
        self.lease=sqlite3.connect(str(lock));self.lease.execute('PRAGMA busy_timeout=0');self.lease.execute('BEGIN EXCLUSIVE')
        owner_file=self.storage/'runtime/desktop-owner.json'
        if owner_file.exists():
            self.owner=private_json(owner_file,4096)
            exact(self.owner,['version','storageId','owner','name','image','launchId','id','engineId','context','instanceId','profileId','sourceDigest','phase'])
            require(self.owner['phase'] in ('create-intent','created','start-intent','running') and self.owner['sourceDigest']==self.source_digest and self.owner['version']==1 and self.owner['storageId']==self.launch['storageId'] and self.owner['engineId']==self.launch['engineId'] and self.owner['context']==self.launch['context'] and UUID.fullmatch(self.owner['owner']) and self.owner['name']=='abyssus-desktop-'+self.owner['owner'] and SHA.fullmatch(self.owner['image']) and UUID.fullmatch(self.owner['launchId']) and (self.owner['id'] is None or re.fullmatch('[a-f0-9]{64}',self.owner['id'])),'OWNERSHIP_CHANGED')
            old=self.owned()
            # Reconnect is explicit observation of the retained private session, never start/replay.
            if old and old['State']['Running']:
                require(self.owner['image']==self.launch['controllerImage'],'RUNTIME_IMAGE_CHANGED')
                retained=private_json(self.storage/'runtime/control/desktop-launch.json',2048)
                require(retained['storageId']==self.launch['storageId'] and retained['launchId']==self.owner['launchId'],'SESSION_CHANGED')
                self.launch.update({key:retained[key] for key in ('key','token','launchId')})
                self.broker_hello();return self.descriptor(old,True)
            not_started=self.owner['phase'] in ('create-intent','created') and self.owner['instanceId'] is None and (old is None or old['State']['Status']=='created')
            require(not_started or self.stopped_receipt() and (old is None or old['State']['Status']=='exited' and old['State']['ExitCode']==0),'CLEANUP_UNCERTAIN')
            if old:self.call(['rm',old['Id']])
        try:self.broker_hello()
        except (FileNotFoundError,ConnectionRefusedError):
            self.broker=subprocess.Popen([sys.executable,'-I','-B',str(self.source/'containers/broker/server.py'),str(self.storage),self.launch['storageId'],str(self.source),self.launch['context']],env=self.env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            end=time.monotonic()+180
            while True:
                require(self.broker.poll() is None,'BROKER_START_FAILED')
                try:self.broker_hello();break
                except (FileNotFoundError,ConnectionRefusedError):require(time.monotonic()<end,'BROKER_START_TIMEOUT');time.sleep(.1)
        capability={key:self.launch[key] for key in ('storageId','launchId','key','token')};capability['version']=1
        file=self.storage/'runtime/control/desktop-launch.json'
        temporary=file.with_name('desktop-launch-'+secrets.token_hex(16)+'.pending');write_new(temporary,capability);temporary.replace(file)
        token=str(uuid.uuid4())
        self.save({'version':1,'storageId':self.launch['storageId'],'owner':token,'name':'abyssus-desktop-'+token,'image':self.launch['controllerImage'],'launchId':self.launch['launchId'],'id':None,'engineId':self.launch['engineId'],'context':self.launch['context'],'instanceId':None,'profileId':None,'sourceDigest':self.source_digest,'phase':'create-intent'})
        args=['create','--name',self.owner['name'],'--label','abyssus.desktop='+token,'--label','abyssus.storage='+self.launch['storageId'],'--init','--network','bridge','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','2g','--cpus','2','--user',f'{os.getuid()}:{os.getgid()}','--tmpfs','/tmp:size=128m,mode=1777','-p','127.0.0.1::3000','-e','HARNESS_EXECUTION_MODE=container','-e','HARNESS_DESKTOP=1','-e','HARNESS_STORAGE_ID='+self.launch['storageId']]
        for source,target,readonly in [('state','/abyssus',False),('config','/abyssus/profile/config',False),('workspace','/workspace',False),('runtime/control','/run/abyssus-broker',True)]:args+=['--mount',f'type=bind,src={self.storage/source},dst={target}'+(',readonly' if readonly else '')]
        container=self.call([*args,self.launch['controllerImage']]).strip()
        require(re.fullmatch('[a-f0-9]{64}',container),'INVALID_CONTAINER_ID');self.save({**self.owner,'id':container,'phase':'created'})
        self.owned();self.save({**self.owner,'phase':'start-intent'});self.call(['start',container]);self.save({**self.owner,'phase':'running'})
        return self.descriptor(self.owned(),False)

    def descriptor(self,info,reconnect):
        require(info is not None and info['State']['Running'],'CONTROLLER_NOT_RUNNING')
        end=time.monotonic()+30
        while True:
            self.storage_check();self.owned()
            try:
                value=private_json(self.storage/'state/backend.json',4096)
                if value.get('key')==self.launch['key'] and value.get('identity',{}).get('state')=='ready':break
            except FileNotFoundError:pass
            require(time.monotonic()<end,'CONTROLLER_NOT_READY');time.sleep(.1)
        ports=info['NetworkSettings']['Ports']['3000/tcp']
        require(len(ports)==1 and ports[0]['HostIp']=='127.0.0.1' and ports[0]['HostPort'].isdigit(),'UNSAFE_ENDPOINT')
        self.save({**self.owner,'instanceId':value['identity']['instanceId'],'profileId':value['identity']['profileId']})
        return {'address':'http://127.0.0.1:'+ports[0]['HostPort'],'identity':value['identity'],'checks':[],'reconnect':reconnect,'key':self.launch['key'],'token':self.launch['token']}

    def broker_hello(self):
        result=broker_request(str(self.storage),'hello')
        exact(result,['protocol','sessionId','storageId','imageId','available'])
        descriptor=private_json(self.storage/'runtime/control/session.json',2048)
        require(result['protocol']=='abyssus-worker-v1' and result['sessionId']==descriptor['sessionId'] and result['storageId']==self.launch['storageId'] and result['imageId']==self.launch['workerImage'] and result['available'] is True,'BROKER_IDENTITY_CHANGED')
        binding=broker_request(str(self.storage),'desktop_hello')
        exact(binding,['protocol','revision','sessionId','storageId','imageId','engineId','context','sourceDigest'])
        require(binding=={'protocol':result['protocol'],'revision':1,'sessionId':result['sessionId'],'storageId':self.launch['storageId'],'imageId':self.launch['workerImage'],'engineId':self.launch['engineId'],'context':self.launch['context'],'sourceDigest':self.source_digest},'BROKER_IDENTITY_CHANGED')
        return result

    def stopped_receipt(self):
        try:
            capability=private_json(self.storage/'runtime/control/desktop-launch.json',2048)
            value=private_json(self.storage/'state/backend.json',4096)
            exact(value,['version','instanceId','profileId','state','mac'])
            unsigned={k:value[k] for k in ['version','instanceId','profileId','state']}
            expected=hmac.new(capability['key'].encode(),json.dumps(unsigned,separators=(',',':')).encode(),hashlib.sha256).hexdigest()
            return capability['launchId']==self.owner['launchId'] and value['state']=='stopped' and value['version']==1 and value['instanceId']==self.owner['instanceId'] and value['profileId']==self.owner['profileId'] and hmac.compare_digest(expected,value['mac'])
        except Exception:return False

    def wait_broker_exit(self):
        # The signed shutdown response precedes listener/proxy/journal teardown.
        # This lifetime lease is required even after supervisor crash/reconnect,
        # where no live child-process handle exists. Never inspect a guessed PID.
        import fcntl
        from transfers import root_handle
        with root_handle(self.storage/'runtime') as parent:
            fd=os.open('broker.lock',os.O_RDWR|os.O_NOFOLLOW,dir_fd=parent)
            try:
                from native_io import private_fd
                private_fd(fd);end=time.monotonic()+20
                while True:
                    try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);break
                    except BlockingIOError:
                        require(time.monotonic()<end,'BROKER_EXIT_UNVERIFIED');time.sleep(.05)
                require(not (self.storage/'runtime/control/session.json').exists(),'BROKER_ENDPOINT_RETAINED')
            finally:os.close(fd)

    def dispatch(self,request):
        op=request.get('op')
        if op=='stopped':
            exact(request,['op']);self.storage_check();info=self.owned()
            return {'stopped':self.stopped_receipt() and (info is None or not info['State']['Running'] and info['State']['Status']=='exited' and info['State']['ExitCode']==0)}
        if op=='drain':
            exact(request,['op']);require(self.dispatch({'op':'stopped'})['stopped'],'CONTROLLER_DRAIN_UNVERIFIED')
            result=broker_request(str(self.storage),'shutdown');require(result=={'stopped':True},'BROKER_DRAIN_UNVERIFIED')
            if self.broker:require(self.broker.wait(timeout=20)==0,'BROKER_DRAIN_UNVERIFIED')
            self.wait_broker_exit()
            info=self.owned()
            if info:self.call(['rm',info['Id']])
            return {'stopped':True}
        if op=='transfer-select':
            exact(request,['op','kind','path','project','included','history']);require(len(self.pending)<16,'SELECTION_LIMIT')
            self.storage_check();require(self.owned()['State']['Running'],'CONTROLLER_NOT_RUNNING')
            token,ticket=select(str(self.storage),self.launch['storageId'],str(self.source),request['kind'],request['path'],request['project'],request['included'],request['history'])
            handle=secrets.token_hex(32);self.pending[handle]=(token,ticket)
            manifest=ticket['manifest']
            return {'handle':handle,'files':len(manifest['entries']),'bytes':manifest['bytes'],'excluded':manifest['excluded'][:100],'excludedCount':len(manifest['excluded']),'history':manifest['history']}
        if op=='transfer-authorize':
            exact(request,['op','handle']);require(request['handle'] in self.pending,'SELECTION_EXPIRED')
            token,ticket=self.pending.pop(request['handle']);authorize(str(self.storage),token,ticket);return {'code':token}
        if op=='transfer-discard':
            exact(request,['op','handle']);self.pending.pop(request['handle'],None);return {'discarded':True}
        raise Denied('UNSUPPORTED_OPERATION')


def main():
    os.umask(0o077)
    raw=sys.stdin.buffer.readline(16385);require(len(raw)<=16384 and raw.endswith(b'\n'),'INVALID_LAUNCH')
    if os.name=='nt':
        from windows_client import WindowsDesktopHost
        host=WindowsDesktopHost(json.loads(raw))
    else:host=DesktopHost(json.loads(raw))
    try:value=host.start()
    except Exception as error:
        print(canonical({'startupFailure':type(error).__name__,'ownedPhase':host.owner.get('phase') if host.owner else None}),file=sys.stderr,flush=True)
        raise
    print(canonical({'ready':value}),flush=True)
    while True:
        raw=sys.stdin.buffer.readline(16385)
        if not raw:break
        require(len(raw)<=16384 and raw.endswith(b'\n'),'INVALID_REQUEST')
        request=json.loads(raw);exact(request,['id','request']);require(type(request['id']) is int and 0<request['id']<2**31,'INVALID_REQUEST')
        try:reply={'id':request['id'],'result':host.dispatch(request['request'])}
        except Exception as error:reply={'id':request['id'],'error':str(error) if isinstance(error,Denied) else 'SUPERVISION_UNCERTAIN'}
        print(canonical(reply),flush=True)
    if os.name=='nt':host.close()
    # Parent loss does not kill guessed PIDs or replay cleanup. Exact owned state
    # and private capabilities remain for explicit authenticated reconnect/drain.

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(canonical({'error':str(error) if isinstance(error,Denied) else 'SUPERVISION_UNCERTAIN'}),flush=True)
        raise SystemExit(1)
