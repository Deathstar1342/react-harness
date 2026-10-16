"""Measure project identity through the controller's complete workspace bind.

The selected original is never mounted. A failed observation is not retried by
this adapter; the published copy remains unregistered and uncertain.
"""
import json
import secrets
from protocol import require,exact,canonical,UUID
from storage_proof import validate_binding


def linux_identity(value):
    import re
    exact(value,['dev','ino'])
    require(all(type(v) is str and re.fullmatch('[0-9]{1,30}',v) for v in value.values()),'INVALID_LINUX_IDENTITY')
    return [value['dev'],value['ino']]


class ProjectIdentity:
    def __init__(self,docker,binding,session,workspace):
        validate_binding(binding)
        require(type(session) is str and UUID.fullmatch(session),'INVALID_PROJECT_MAPPING_SESSION')
        linux_identity(workspace)
        self.docker=docker;self.binding=dict(binding);self.session=session;self.workspace=dict(workspace)
        self.failed=False
    def observe(self,project):
        require(not self.failed,'PROJECT_MAPPING_RECOVERY_REQUIRED')
        require(type(project) is str and UUID.fullmatch(project),'INVALID_MANAGED_PROJECT')
        try:
            self.docker.verify_engine();self.docker.storage_barrier()
            challenge={'version':1,'nonce':secrets.token_hex(32),'launchId':self.binding['launchId'],'storageId':self.binding['storageId'],'sessionId':self.session,'project':project}
            source=str(self.docker.storage/'workspace');require(',' not in source,'UNSAFE_PROBE_PATH')
            image=self.binding['controllerImage'];command='/app/containers/project-identity-probe.mjs'
            args=['--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','16','--memory','128m','--cpus','1','--user',f'{self.docker.uid}:{self.docker.gid}','--tmpfs','/tmp:size=8m,mode=1777','--mount',f'type=bind,src={source},dst=/workspace,readonly','--entrypoint','/usr/local/bin/node','-i',image,command]
            container=self.docker.resources.create(args,image,'attestation')
            info=self.docker.resources.verify(self.docker.resources.find(container));config=info['HostConfig']
            require(config['NetworkMode']=='none' and config['ReadonlyRootfs'] and not config['Privileged'] and config['CapDrop']==['ALL'] and config['SecurityOpt']==['no-new-privileges'],'UNSAFE_PROJECT_PROBE')
            require(not any(config.get(key) for key in ('CapAdd','Devices','DeviceRequests','VolumesFrom','Binds','PidMode','UTSMode')) and config.get('IpcMode')=='private','UNSAFE_PROJECT_PROBE')
            require(config.get('PidsLimit')==16 and config.get('Memory')==134217728 and config.get('NanoCpus')==1000000000 and config.get('Tmpfs')=={'/tmp':'size=8m,mode=1777'},'UNSAFE_PROJECT_PROBE')
            require(info['Config']['User']==f'{self.docker.uid}:{self.docker.gid}' and info['Config']['Entrypoint']==['/usr/local/bin/node'] and info['Config']['Cmd']==[command],'UNSAFE_PROJECT_PROBE')
            mounts=info['Mounts'];require(len(mounts)==1 and mounts[0]['Type']=='bind' and mounts[0]['Destination']=='/workspace' and mounts[0]['RW'] is False,'UNSAFE_PROJECT_PROBE_MOUNTS')
            selected=config.get('Mounts');require(type(selected) is list and len(selected)==1 and selected[0].get('Type')=='bind' and selected[0].get('Source')==source and selected[0].get('Target')=='/workspace' and selected[0].get('ReadOnly') is True,'PROJECT_PROBE_SOURCE_CHANGED')
            self.docker.storage_barrier()
            raw=self.docker.call(['start','--attach','--interactive',container],timeout=30,input=canonical(challenge)+'\n')
            require(len(raw)<=8192,'PROJECT_PROBE_LIMIT');value=json.loads(raw)
            exact(value,[*challenge,'workspace','identity'])
            require(type(value['version']) is int and all(value[key]==item for key,item in challenge.items()),'PROJECT_PROBE_BINDING_CHANGED')
            identity=linux_identity(value['identity']);linux_identity(value['workspace'])
            require(value['workspace']==self.workspace and identity[0]==self.workspace['dev'] and identity[1]!=self.workspace['ino'],'PROJECT_WORKSPACE_CHANGED')
            info=self.docker.resources.verify(self.docker.resources.find(container))
            require(info['State']['Status']=='exited' and info['State']['ExitCode']==0,'PROJECT_PROBE_FAILED')
            self.docker.resources.remove(container)
            self.docker.verify_engine();self.docker.storage_barrier()
            return {'binding':self.binding,'sessionId':self.session,'project':project,'workspace':self.workspace,'identity':identity}
        except BaseException:self.failed=True;raise
