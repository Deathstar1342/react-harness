"""Durable infrastructure ownership. Recovery only stops/removes, never executes."""
import json
import re
import sqlite3
import threading
import uuid
from protocol import canonical, require

class Resources:
    def __init__(self, docker):
        self.docker = docker
        self.lock = threading.RLock()
        self.db = sqlite3.connect(str(docker.storage / 'runtime/worker-resources.sqlite'), check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=DELETE')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS resources(token TEXT PRIMARY KEY,data TEXT NOT NULL)')

    def save(self, row):
        with self.lock, self.db:
            self.db.execute('INSERT INTO resources VALUES (?,?) ON CONFLICT(token) DO UPDATE SET data=excluded.data', (row['token'],canonical(row)))

    def create(self, args, image, kind):
        require(kind in ('worker','maintenance','companion','attestation','controller'))
        token=str(uuid.uuid4())
        row={'token':token,'name':'abyssus-owned-'+token,'image':image,'kind':kind,'id':None,'phase':'intent'}
        with self.lock:
            require(self.db.execute('SELECT count(*) FROM resources').fetchone()[0] < 20000,'RESOURCE_CAPACITY')
            self.save(row)  # Before Docker can create anything, including lost replies.
        result=self.docker.call(['create','--name',row['name'],'--label','abyssus.owner='+token,'--label','abyssus.storage='+self.docker.storage_id,*args]).strip()
        require(re.fullmatch('[a-f0-9]{64}',result),'INVALID_CONTAINER_ID')
        row.update(id=result,phase='created')
        self.save(row)
        self.verify(row)
        return result

    def find(self, container):
        require(type(container) is str and re.fullmatch('[a-f0-9]{64}',container),'INVALID_CONTAINER_ID')
        with self.lock:
            for (raw,) in self.db.execute('SELECT data FROM resources'):
                row=json.loads(raw)
                if row['id']==container:
                    return row
        raise RuntimeError('RESOURCE_NOT_OWNED')

    def present(self, row):
        # A successful daemon inventory distinguishes absence from engine failure.
        selector='id='+row['id'] if row['id'] else 'name=^/'+row['name']+'$'
        values=self.docker.call(['ps','-a','--no-trunc','--filter',selector,'--format','{{.ID}}']).splitlines()
        require(len(values)<=1,'RESOURCE_IDENTITY_CHANGED')
        if not values:
            return False
        require(re.fullmatch('[a-f0-9]{64}',values[0]) and (not row['id'] or row['id']==values[0]),'RESOURCE_IDENTITY_CHANGED')
        if not row['id']:
            # Lost create reply: exact durable random name plus labels/image proof
            # permits cleanup only. This never adopts a worker for execution.
            row['id']=values[0]
            self.verify(row)
            row['phase']='recovered-for-cleanup'
            self.save(row)
        return True

    def verify(self, row):
        info=json.loads(self.docker.call(['inspect',row['id']]))[0]
        labels=info['Config'].get('Labels') or {}
        require(info['Id']==row['id'] and info['Name']=='/'+row['name'] and info['Image']==row['image'] and labels.get('abyssus.owner')==row['token'] and labels.get('abyssus.storage')==self.docker.storage_id,'RESOURCE_IDENTITY_CHANGED')
        return info

    def remove(self, container):
        row=self.find(container)
        if self.present(row):
            self.verify(row)
            self.docker.call(['rm','--force',container])
            require(not self.present(row),'CLEANUP_UNCERTAIN')
        row['phase']='removed'
        self.save(row)

    def stop(self, container):
        row=self.find(container)
        if not self.present(row):
            row['phase']='removed';self.save(row)
            return False
        if self.verify(row)['State']['Running']:
            self.docker.call(['stop','--time','5',container])
        require(not self.verify(row)['State']['Running'],'CLEANUP_UNCERTAIN')
        row['phase']='retained-stopped';self.save(row)
        return True

    def recover(self):
        errors=[]
        with self.lock:
            rows=[json.loads(raw) for (raw,) in self.db.execute('SELECT data FROM resources')]
        for row in rows:
            if row['phase']=='removed':
                continue
            try:
                if not self.present(row):
                    row['phase']='removed';self.save(row);continue
                info=self.verify(row)
                if row['kind']=='maintenance':
                    self.stop(row['id'])
                else:
                    self.remove(row['id'])
            except Exception:
                errors.append(row['token'])
        require(not errors,'OWNED_RESOURCE_RECOVERY_UNCERTAIN')
