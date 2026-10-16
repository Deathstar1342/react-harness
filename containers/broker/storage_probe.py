"""Fixed-image read-only slot probe, exact owned creation and no replay."""
from pathlib import Path
import json
import secrets
from protocol import require,canonical
from storage_proof import validate_probe,SLOTS

class FixedStorageProbe:
    def __init__(self,docker,image,uid,gid):
        self.docker=docker;self.image=image;self.uid=uid;self.gid=gid
    def __call__(self,challenge):
        storage=self.docker.storage
        area=storage/'runtime/probes'/challenge['probeId'];area.mkdir(parents=True,mode=0o700)
        mounts=[(storage/('runtime/control' if slot=='control' else slot),'/probe/'+slot,True) for slot in SLOTS]
        mounts.append((area,'/probe/write',False))
        args=['--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','32','--memory','256m','--cpus','1','--user',f'{self.uid}:{self.gid}','--tmpfs','/tmp:size=16m,mode=1777','--entrypoint','/usr/local/bin/node','-i']
        for source,target,readonly in mounts:
            require(',' not in str(source),'UNSAFE_PROBE_PATH');args+=['--mount',f'type=bind,src={source},dst={target}'+(',readonly' if readonly else '')]
        args += [self.image,'/app/containers/storage-probe.mjs']
        container=self.docker.resources.create(args,self.image,'attestation')
        # Retain durable ownership on lost create/start replies. No auto retry.
        info=self.docker.resources.verify(self.docker.resources.find(container));config=info['HostConfig']
        require(config['NetworkMode']=='none' and config['ReadonlyRootfs'] and not config['Privileged'] and config['CapDrop']==['ALL'] and not config.get('CapAdd') and not config.get('Devices') and not config.get('DeviceRequests') and not config.get('VolumesFrom') and not config.get('Binds') and not config.get('PidMode') and config.get('IpcMode')=='private' and not config.get('UTSMode') and config['SecurityOpt']==['no-new-privileges'],'UNSAFE_PROBE_CONFIG')
        require(info['Config']['User']==f'{self.uid}:{self.gid}' and info['Config']['Entrypoint']==['/usr/local/bin/node'] and info['Config']['Cmd']==['/app/containers/storage-probe.mjs'],'UNSAFE_PROBE_COMMAND')
        expected={target:not readonly for source,target,readonly in mounts}
        require(len(info['Mounts'])==5 and all(m['Type']=='bind' and expected.get(m['Destination'])==m['RW'] for m in info['Mounts']),'UNSAFE_PROBE_MOUNTS')
        # HostConfig retains source selection. Runtime/native guard independently
        # checks the selected handles; probe results bind measured Linux IDs.
        selected={(str(source),target,readonly) for source,target,readonly in mounts}
        require({(m['Source'],m['Target'],m.get('ReadOnly',False)) for m in config['Mounts']}==selected,'PROBE_SOURCE_CHANGED')
        result=self.docker.call(['start','--attach','--interactive',container],timeout=60,input=canonical(challenge)+'\n')
        info=self.docker.resources.verify(self.docker.resources.find(container))
        require(info['State']['Status']=='exited' and info['State']['ExitCode']==0,'STORAGE_PROBE_FAILED')
        require(len(result)<=8192,'STORAGE_PROBE_LIMIT');value=json.loads(result);validate_probe(value,challenge)
        self.docker.resources.remove(container)
        return value
