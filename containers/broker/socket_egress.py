"""Credential-free egress companion and ephemeral socket-only owned volume.

No arbitrary volume API is exposed. Recovery removes exact recorded resources;
this storage never carries project/controller/configuration data.
"""
import json
import re
import time
import uuid
from protocol import require,canonical,exact,UUID

class SocketEgress:
    def __init__(self,docker):
        self.docker=docker;self.db=docker.resources.db;self.lock=docker.resources.lock;self.container=None;self.row=None
        self.db.execute('CREATE TABLE IF NOT EXISTS egress_volumes(token TEXT PRIMARY KEY,data TEXT NOT NULL)')
    def validate_row(self,row):
        exact(row,['token','name','image','createdAt','mountpoint','phase'])
        require(type(row['token']) is str and UUID.fullmatch(row['token']) and row['name']=='abyssus-egress-'+row['token'],'SOCKET_VOLUME_CHANGED')
        require(type(row['image']) is str and re.fullmatch('sha256:[a-f0-9]{64}',row['image']) and row['phase'] in ('intent','created','removed'),'SOCKET_VOLUME_CHANGED')
        require(row['createdAt'] is None and row['mountpoint'] is None or type(row['createdAt']) is str and len(row['createdAt'])<=128 and type(row['mountpoint']) is str and 0<len(row['mountpoint'])<=4096,'SOCKET_VOLUME_CHANGED')
    def save(self,row):
        self.validate_row(row)
        with self.lock,self.db:self.db.execute('INSERT INTO egress_volumes VALUES (?,?) ON CONFLICT(token) DO UPDATE SET data=excluded.data',(row['token'],canonical(row)))
    def present(self,row):
        self.validate_row(row)
        names=self.docker.call(['volume','ls','--filter','name=^'+row['name']+'$','--format','{{.Name}}']).splitlines()
        require(names in ([],[row['name']]),'SOCKET_VOLUME_CHANGED');return bool(names)
    def verify(self,row):
        self.validate_row(row)
        info=json.loads(self.docker.call(['volume','inspect',row['name']]))[0]
        expected={'abyssus.egress':row['token'],'abyssus.storage':self.docker.storage_id,'abyssus.image':row['image']}
        require(info['Name']==row['name'] and info['Driver']=='local' and info['Scope']=='local' and info.get('Labels')==expected and not info.get('Options'),'SOCKET_VOLUME_CHANGED')
        if row.get('createdAt'):require(info['CreatedAt']==row['createdAt'] and info['Mountpoint']==row['mountpoint'],'SOCKET_VOLUME_CHANGED')
        return info
    def remove_volume(self,row):
        if self.present(row):
            self.verify(row);self.docker.call(['volume','rm',row['name']]);require(not self.present(row),'SOCKET_VOLUME_CLEANUP_UNCERTAIN')
        row['phase']='removed';self.save(row)
    def recover(self):
        # Called only after Resources.recover has removed exact owned companions
        # and workers. An unrelated attachment prevents rm and retains uncertainty.
        for (raw,) in self.db.execute('SELECT data FROM egress_volumes').fetchall():
            row=json.loads(raw)
            if row['phase']!='removed':self.remove_volume(row)
    def start(self):
        require(self.db.execute('SELECT count(*) FROM egress_volumes').fetchone()[0]<4096,'SOCKET_VOLUME_CAPACITY')
        token=str(uuid.uuid4());row={'token':token,'name':'abyssus-egress-'+token,'image':self.docker.image,'createdAt':None,'mountpoint':None,'phase':'intent'}
        self.row=row;self.save(row)
        name=self.docker.call(['volume','create','--driver','local','--label','abyssus.egress='+token,'--label','abyssus.storage='+self.docker.storage_id,'--label','abyssus.image='+row['image'],row['name']]).strip()
        require(name==row['name'],'SOCKET_VOLUME_CHANGED');info=self.verify(row);row.update(createdAt=info['CreatedAt'],mountpoint=info['Mountpoint'],phase='created');self.save(row)
        args=['--network','bridge','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','64','--memory','128m','--cpus','1','--user','0:0','--mount',f'type=volume,src={name},dst=/run/egress,volume-nocopy','--entrypoint','/usr/bin/python3',row['image'],'-I','/opt/abyssus-worker/broker/egress.py','/run/egress/proxy.sock']
        self.container=self.docker.resources.create(args,row['image'],'companion');self.verify_container();self.docker.call(['start',self.container]);end=time.monotonic()+10
        while True:
            require(self.poll() is None,'EGRESS_COMPANION_FAILED')
            try:
                self.docker.call(['exec',self.container,'/usr/bin/python3','-I','-c',"import os,stat;assert stat.S_ISSOCK(os.lstat('/run/egress/proxy.sock').st_mode)"]);break
            except Exception:require(time.monotonic()<end,'EGRESS_SOCKET_UNAVAILABLE');time.sleep(.05)
        return self
    def verify_container(self):
        self.verify(self.row);info=self.docker.resources.verify(self.docker.resources.find(self.container));config=info['HostConfig'];mounts=info['Mounts']
        require(len(mounts)==1 and mounts[0]['Type']=='volume' and mounts[0]['Name']==self.row['name'] and mounts[0]['Destination']=='/run/egress' and mounts[0]['RW'] is True,'UNSAFE_EGRESS_MOUNT')
        require(config['NetworkMode']=='bridge' and config['ReadonlyRootfs'] and not config['Privileged'] and config['CapDrop']==['ALL'] and not config.get('CapAdd') and not config.get('Devices') and not config.get('DeviceRequests') and not config.get('Binds') and not config.get('VolumesFrom') and not config.get('PidMode') and config.get('IpcMode')=='private' and not config.get('UTSMode') and not config.get('PortBindings') and config['SecurityOpt']==['no-new-privileges'],'UNSAFE_EGRESS_CONFIG')
        require(info['Config']['User']=='0:0' and info['Config']['Entrypoint']==['/usr/bin/python3'] and info['Config']['Cmd']==['-I','/opt/abyssus-worker/broker/egress.py','/run/egress/proxy.sock'],'UNSAFE_EGRESS_COMMAND')
        return info
    def worker_mount(self):
        require(self.poll() is None,'EGRESS_UNAVAILABLE');return f'type=volume,src={self.row["name"]},dst=/run/egress,readonly,volume-nocopy'
    def poll(self):return None if self.verify_container()['State']['Running'] else 1
    def terminate(self):
        if self.container:self.docker.resources.remove(self.container);self.container=None
        if self.row:self.remove_volume(self.row)
    def wait(self,timeout=None):
        require(self.container is None and self.row and self.row['phase']=='removed','EGRESS_CLEANUP_UNCERTAIN');return 0
