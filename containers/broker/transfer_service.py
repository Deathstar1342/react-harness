"""Private host ticket journal and broker transfer operations. No path-bearing wire API."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import threading
import time
import uuid
from protocol import require, exact, canonical, now, HEX, UUID
from transfers import scan, copy, publish, verify_stage, root_handle, stamp, fsync_dir, component, NEVER

MAX_TICKETS = 128
MAX_RECORDS = 512
MAX_MANIFEST = 32 * 1024**2
TERMINAL = ('succeeded', 'failed', 'cancelled', 'uncertain')


def private_json(file, limit=MAX_MANIFEST):
    with root_handle(file.parent) as parent:
        fd=os.open(file.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info=os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0 and info.st_size <= limit, 'UNSAFE_TRANSFER_RECORD')
            with os.fdopen(os.dup(fd), 'r') as stream:
                return json.load(stream)
        finally:
            os.close(fd)


def write_new(file, value):
    raw=canonical(value).encode()
    require(len(raw) <= MAX_MANIFEST, 'MANIFEST_LIMIT')
    with root_handle(file.parent) as parent:
        fd=os.open(file.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            with os.fdopen(os.dup(fd), 'wb') as stream:
                stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        finally:
            os.close(fd)
        os.fsync(parent)


def area(storage):
    result=Path(storage)/'runtime/transfers'
    for directory in (result, result/'tickets', result/'stages'):
        directory.mkdir(mode=0o700, exist_ok=True)
        with root_handle(directory) as fd:
            info=os.fstat(fd)
            require(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0, 'UNSAFE_TRANSFER_STORAGE')
    return result


def overlap(a,b):
    return a==b or a in b.parents or b in a.parents


def select(storage, storage_id, source_install, kind, selected, project=None, included=(), history=False):
    """Only the interactive host/picker calls this; deliberately absent from broker API."""
    require(kind in ('import','export'), 'INVALID_TRANSFER')
    storage, source_install, selected=Path(storage),Path(source_install),Path(selected)
    with root_handle(storage) as fd:
        storage_stamp=stamp(os.fstat(fd))[:2]
    require((storage/'.storage-id').read_text().strip() == storage_id, 'STORAGE_CHANGED')
    require(not any(part.casefold() in NEVER for part in selected.parts), 'PROTECTED_TRANSFER_ROOT')
    require(selected.is_absolute() and str(selected) == os.path.normpath(selected), 'UNSAFE_ROOT')
    require(not overlap(selected,storage) and not overlap(selected,source_install) and selected != Path.home(), 'PROTECTED_TRANSFER_ROOT')
    descriptor=private_json(storage/'runtime/control/session.json',2048)
    require(descriptor['storageId']==storage_id, 'STORAGE_CHANGED')
    base=area(storage)
    require(sum(1 for _ in (base/'tickets').iterdir()) < MAX_TICKETS, 'TRANSFER_TICKET_CAPACITY')
    if kind=='import':
        root=selected
        with root_handle(root): pass
        destination=storage/'workspace'/str(uuid.uuid4())
        project=destination.name
    else:
        require(type(project) is str and '/' not in project and '\\' not in project, 'INVALID_PROJECT')
        component(project)
        root=storage/'workspace'/project
        with root_handle(root): pass
        with root_handle(selected.parent): pass
        require(not selected.exists() and not selected.is_symlink(), 'DESTINATION_EXISTS')
        destination=selected
    manifest=scan(root,included,history)
    with root_handle(destination.parent) as parent:
        destination_parent=stamp(os.fstat(parent))[:2]
    token=secrets.token_hex(32)
    ticket={'id':str(uuid.uuid4()),'kind':kind,'storageId':storage_id,'sessionId':descriptor['sessionId'],
            'storageStamp':storage_stamp,'source':str(root),'destination':str(destination),'destinationParent':destination_parent,
            'project':project,'manifest':manifest,'expiresAt':now()+15*60*1000,'tokenHash':hashlib.sha256(token.encode()).hexdigest()}
    # Caller must explicitly confirm the already prepared manifest before writing.
    return token,ticket


def authorize(storage, token, ticket):
    require(HEX.fullmatch(token) and hashlib.sha256(token.encode()).hexdigest()==ticket['tokenHash'], 'INVALID_TICKET')
    write_new(area(storage)/'tickets'/ticket['tokenHash'],ticket)


class Transfers:
    def __init__(self,broker):
        self.broker=broker; self.db=broker.journal.db; self.root=Path(broker.docker.storage)/'runtime/transfers'
        self.threads={}; self.cancelled=set(); self.heartbeats={}
        self.db.execute('CREATE TABLE IF NOT EXISTS transfers(id TEXT PRIMARY KEY,data TEXT NOT NULL)')
        for (raw,) in self.db.execute('SELECT data FROM transfers').fetchall():
            row=json.loads(raw)
            if row['phase'] not in TERMINAL:
                row.update(phase='uncertain',code='BROKER_RESTARTED',residue=True)
                self.save(row)

    def save(self,row):
        with self.db:
            self.db.execute('INSERT INTO transfers VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',(row['id'],canonical(row)))

    def rows(self):
        return [json.loads(raw) for (raw,) in self.db.execute('SELECT data FROM transfers')]

    def busy(self,project):
        return any(row['project']==project and row['kind']=='export' and row['phase'] not in TERMINAL for row in self.rows())

    def idle(self,project):
        require(not self.broker.packages.busy(project), 'INSTALL_RECOVERY_REQUIRED')
        require(not any(json.loads(raw)['project']==project and json.loads(raw)['state'] in ('prepared','accepted','running','uncertain') for (raw,) in self.db.execute('SELECT data FROM claims')), 'PROJECT_BUSY')
        require(not any(value.get('project')==project for value in self.broker.docker.contexts.values()), 'WORKER_NOT_DRAINED')

    def public(self,row):
        return {key:row[key] for key in ('id','kind','project','phase','code','residue','manifestDigest','files','bytes','excludedCount','excluded','history','storageId','sessionId','identity')}

    def get(self,token):
        require(type(token) is str and HEX.fullmatch(token), 'INVALID_TRANSFER_CODE')
        digest=hashlib.sha256(token.encode()).hexdigest()
        for row in self.rows():
            if row['tokenHash']==digest:
                return row
        raise ValueError('Unknown transfer')

    def dispatch(self,op,body):
        exact(body,['code','kind','project'] if op=='transfer_begin' else ['code'])
        token=body['code']
        require(type(token) is str and HEX.fullmatch(token), 'INVALID_TRANSFER_CODE')
        if op=='transfer_begin':
            digest=hashlib.sha256(token.encode()).hexdigest()
            require(not any(row['tokenHash']==digest for row in self.rows()), 'TRANSFER_ALREADY_CONSUMED')
            require(len(self.rows())<MAX_RECORDS, 'TRANSFER_RECORD_CAPACITY')
            ticket=private_json(self.root/'tickets'/digest)
            require(ticket['tokenHash']==digest and ticket['storageId']==self.broker.docker.storage_id and ticket['sessionId']==self.broker.journal.session and ticket['expiresAt']>now(), 'TRANSFER_TICKET_EXPIRED')
            require(body['kind']==ticket['kind'] and (body['project'] is None if ticket['kind']=='import' else body['project']==ticket['project']), 'TRANSFER_TARGET_MISMATCH')
            if ticket['kind']=='export':
                require(not self.busy(ticket['project']), 'TRANSFER_BUSY')
                self.idle(ticket['project'])
            row={**ticket,'phase':'copying','code':'COPYING','residue':True,'manifestDigest':ticket['manifest']['digest'],
                 'files':sum(i['kind']=='file' for i in ticket['manifest']['entries']),'bytes':ticket['manifest']['bytes'],
                 'excludedCount':len(ticket['manifest']['excluded']),'excluded':ticket['manifest']['excluded'][:100],
                 'history':ticket['manifest']['history'],'identity':None}
            self.save(row) # Durable consumption before thread or filesystem effect.
            self.heartbeats[row['id']]=time.monotonic()
            thread=threading.Thread(target=self.run,args=(row,),daemon=True)
            self.threads[row['id']]=thread;thread.start()
            return self.public(row)
        row=self.get(token)
        if op=='transfer_observe':
            self.heartbeats[row['id']]=time.monotonic()
            return self.public(row)
        if op=='transfer_cancel':
            self.cancelled.add(row['id'])
            return self.public(row)
        if op=='transfer_receipt':
            require(row['phase']=='succeeded' and row['kind']=='import', 'TRANSFER_NOT_COMPLETE')
            require(not row.get('redeemed'), 'TRANSFER_RECEIPT_CONSUMED')
            with root_handle(row['destination']) as fd:
                require(stamp(os.fstat(fd))[:2]==row['identity'], 'TRANSFER_IDENTITY_CHANGED')
            require(verify_stage(row['destination'],row['manifest'])==row['identity'],'TRANSFER_IDENTITY_CHANGED')
            row['redeemed']=True;self.save(row)
            return self.public(row)
        raise ValueError('Unknown transfer operation')

    def run(self,row):
        def check():
            with self.broker.lock:
                require(row['id'] not in self.cancelled and not self.broker.closing, 'TRANSFER_CANCELLED')
                require(now()<row['expiresAt'] and time.monotonic()-self.heartbeats[row['id']]<15, 'TRANSFER_HEARTBEAT_LOST')
                if row['kind']=='export': self.idle(row['project'])
        try:
            check()
            with root_handle(self.broker.docker.storage) as fd:
                require(stamp(os.fstat(fd))[:2]==row['storageStamp'],'STORAGE_CHANGED')
            stage=self.root/'stages'/row['id'] if row['kind']=='import' else Path(row['destination']).parent/('.abyssus-transfer-'+row['id'])
            copy(row['source'],stage,row['manifest'],check=check,parent_identity=row['destinationParent'] if row['kind']=='export' else None)
            stage_identity=verify_stage(stage,row['manifest'],check)
            with self.broker.lock:
                check()
                with root_handle(Path(row['destination']).parent) as parent:
                    require(stamp(os.fstat(parent))[:2]==row['destinationParent'],'DESTINATION_CHANGED')
                row.update(phase='publishing',code='PUBLISHING');self.save(row)
                publish(stage,Path(row['destination']),stage_identity,row['destinationParent'])
                with root_handle(row['destination']) as fd:
                    row['identity']=stamp(os.fstat(fd))[:2]
                row.update(phase='succeeded',code='COMPLETE_WITH_EXCLUSIONS' if row['excludedCount'] else 'COMPLETE',residue=False)
                self.save(row)
        except Exception as error:
            with self.broker.lock:
                # A publication or commit failure may have left a complete destination.
                row.update(phase='uncertain' if row['phase']=='publishing' else 'cancelled' if row['id'] in self.cancelled else 'failed',code='TRANSFER_INCOMPLETE',residue=True)
                self.save(row)

    def close(self):
        with self.broker.lock:
            self.cancelled.update(self.threads)
            threads=list(self.threads.values())
        for thread in threads:
            thread.join(timeout=30)
            require(not thread.is_alive(),'TRANSFER_DRAIN_UNCERTAIN')
