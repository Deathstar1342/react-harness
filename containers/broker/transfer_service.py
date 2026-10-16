"""Private host ticket journal and broker transfer operations. No path-bearing wire API."""
import contextlib
import hashlib
import re
import json
from native_io import fs as os, private_fd
from pathlib import Path
import secrets
import stat
import threading
import time
import uuid
from protocol import Denied, require, exact, canonical, now, HEX, UUID
from transfers import scan, copy, publish, verify_stage, verify_source_metadata, root_handle, stamp, fsync_dir, component, NEVER

MAX_TICKETS = 128
MAX_RECORDS = 512
MAX_MANIFEST = 32 * 1024**2
TERMINAL = ('succeeded', 'failed', 'cancelled', 'uncertain')


def private_json(file, limit=MAX_MANIFEST):
    with root_handle(file.parent) as parent:
        fd=os.open(file.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info=os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= limit, 'UNSAFE_TRANSFER_RECORD')
            private_fd(fd)
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
        directory.mkdir(mode=0o777 if os.name=='nt' else 0o700, exist_ok=True)
        with root_handle(directory) as fd:
            info=os.fstat(fd)
            private_fd(fd)
    return result


def overlap(a,b):
    return a==b or a in b.parents or b in a.parents


MAX_ORIGINS = 128
MAX_LINEAGE = 1024**2


@contextlib.contextmanager
def lineage_lock(base, wait=False):
    # Every host process uses this same lock. Broker admission never waits while
    # holding its own lock; the copy thread waits before taking the broker lock.
    if os.name=='nt':
        from windows_handles import exclusive_lock
        try:
            with exclusive_lock(Path(base)/'origins.lock',wait):yield
        except BlockingIOError:raise Denied('TRANSFER_LINEAGE_BUSY') from None
        return
    import fcntl
    with root_handle(base) as parent:
        fd=os.open('origins.lock',os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,0o600,dir_fd=parent)
        try:
            info=os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_uid==os.getuid() and info.st_mode & 0o077==0,'UNSAFE_TRANSFER_LINEAGE')
            try: fcntl.flock(fd,fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
            except BlockingIOError: raise Denied('TRANSFER_LINEAGE_BUSY') from None
            yield
        finally: os.close(fd)


def lineage(base, storage_id):
    try:
        marker=private_json(base/'identity',2048)
        require(set(marker)=={'journalId','storageId','lineageId'} and marker['storageId']==storage_id,'TRANSFER_LINEAGE_CHANGED')
        require(all(type(marker[key]) is str and UUID.fullmatch(marker[key]) for key in marker),'TRANSFER_LINEAGE_CHANGED')
        index=private_json(base/'origins.json',MAX_LINEAGE)
        require(set(index)=={'journalId','storageId','lineageId','roots'} and all(index[key]==marker[key] for key in marker),'TRANSFER_LINEAGE_CHANGED')
        require(type(index['roots']) is list and len(index['roots'])<=MAX_ORIGINS,'TRANSFER_LINEAGE_CHANGED')
        seen=set()
        for item in index['roots']:
            require(type(item) is dict and set(item)=={'ticketId','source','identity'},'TRANSFER_LINEAGE_CHANGED')
            require(type(item['ticketId']) is str and UUID.fullmatch(item['ticketId']) and item['ticketId'] not in seen,'TRANSFER_LINEAGE_CHANGED');seen.add(item['ticketId'])
            source=item['source']
            require(type(source) is str and len(source.encode())<=4096 and Path(source).is_absolute() and source==os.path.normpath(source) and '\x00' not in source,'TRANSFER_LINEAGE_CHANGED')
            require(type(item['identity']) is list and len(item['identity'])==2 and all(type(i) is str and re.fullmatch(r'[0-9]{1,39}' if os.name=='nt' else r'[0-9]{1,30}',i) for i in item['identity']),'TRANSFER_LINEAGE_CHANGED')
        return index
    except Denied: raise
    except Exception: raise Denied('TRANSFER_LINEAGE_CHANGED') from None


def save_lineage(base,index):
    require(len(canonical(index).encode())<=MAX_LINEAGE,'TRANSFER_LINEAGE_CAPACITY')
    temporary=base/('origins-'+secrets.token_hex(16)+'.tmp')
    write_new(temporary,index)
    with root_handle(base) as parent:
        os.replace(temporary.name,'origins.json',src_dir_fd=parent,dst_dir_fd=parent)
        os.fsync(parent)


def independent_mount(path):
    if os.name=='nt':
        # Full ancestor traversal rejects junctions and volume mount reparses.
        with root_handle(path):pass
        return
    # Only the most-specific containing mount matters: ordinary '/'-rooted
    # filesystems remain supported. A subtree bind/subvolume has another root.
    # Full-filesystem aliases are handled by ancestor device/inode comparison.
    try:
        candidates=[]
        for line in Path('/proc/self/mountinfo').read_text().splitlines():
            fields=line.split()
            decode=lambda value: re.sub(r'\\([0-7]{3})',lambda m:chr(int(m[1],8)),value)
            mount=Path(decode(fields[4]))
            if path==mount or mount in path.parents:candidates.append((len(mount.parts),decode(fields[3])))
        require(bool(candidates) and max(candidates)[1]=='/','UNSUPPORTED_TRANSFER_MOUNT_ALIAS')
    except Denied: raise
    except Exception: raise Denied('UNSUPPORTED_TRANSFER_MOUNT_ALIAS') from None


def protect_originals(index,destination):
    destination=Path(destination)
    independent_mount(destination.parent)
    identities=set()
    for ancestor in (destination.parent,*destination.parent.parents):
        if ancestor==Path(ancestor.anchor): continue
        with root_handle(ancestor) as fd:identities.add(tuple(stamp(os.fstat(fd))[:2]))
    for origin in index['roots']:
        source=Path(origin['source'])
        try:
            independent_mount(source)
            with root_handle(source) as fd:
                require(stamp(os.fstat(fd))[:2]==origin['identity'],'TRANSFER_ORIGINAL_UNAVAILABLE')
        except Denied: raise
        except Exception: raise Denied('TRANSFER_ORIGINAL_UNAVAILABLE') from None
        require(not overlap(source,destination) and tuple(origin['identity']) not in identities,'ORIGINAL_SOURCE_PROTECTED')


def verify_lineage_ticket(index,ticket):
    require(all(ticket[key]==index[key] for key in ('journalId','storageId','lineageId')),'TRANSFER_LINEAGE_CHANGED')
    if ticket['kind']=='import':
        require({'ticketId':ticket['id'],'source':ticket['source'],'identity':ticket['manifest']['root'][:2]} in index['roots'],'TRANSFER_LINEAGE_CHANGED')
    else: protect_originals(index,ticket['destination'])


def select(storage, storage_id, source_install, kind, selected, project=None, included=(), history=False):
    with lineage_lock(area(storage)):
        return select_locked(storage,storage_id,source_install,kind,selected,project,included,history)


def select_locked(storage, storage_id, source_install, kind, selected, project=None, included=(), history=False):
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
    index=lineage(base,storage_id)
    journal_id=index['journalId']
    require(sum(1 for _ in (base/'tickets').iterdir()) < MAX_TICKETS, 'TRANSFER_TICKET_CAPACITY')
    if kind=='import':
        root=selected
        independent_mount(root)
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
        protect_originals(index,destination)
    manifest=scan(root,included,history)
    with root_handle(destination.parent) as parent:
        destination_parent=stamp(os.fstat(parent))[:2]
    token=secrets.token_hex(32)
    ticket={'journalId':journal_id,'lineageId':index['lineageId'],'id':str(uuid.uuid4()),'kind':kind,'storageId':storage_id,'sessionId':descriptor['sessionId'],
            'storageStamp':storage_stamp,'source':str(root),'destination':str(destination),'destinationParent':destination_parent,
            'project':project,'manifest':manifest,'expiresAt':now()+15*60*1000,'tokenHash':hashlib.sha256(token.encode()).hexdigest()}
    # Caller must explicitly confirm the already prepared manifest before writing.
    return token,ticket


def authorize(storage, token, ticket):
    require(HEX.fullmatch(token) and hashlib.sha256(token.encode()).hexdigest()==ticket['tokenHash'], 'INVALID_TICKET')
    base=area(storage)
    with lineage_lock(base):
        index=lineage(base,ticket['storageId'])
        require(all(ticket[key]==index[key] for key in ('journalId','storageId','lineageId')),'TRANSFER_LINEAGE_CHANGED')
        require(sum(1 for _ in (base/'tickets').iterdir())<MAX_TICKETS,'TRANSFER_TICKET_CAPACITY')
        if ticket['kind']=='import':
            require(not any(origin['ticketId']==ticket['id'] for origin in index['roots']),'TRANSFER_ALREADY_AUTHORIZED')
            require(len(index['roots'])<MAX_ORIGINS,'TRANSFER_LINEAGE_CAPACITY')
            independent_mount(Path(ticket['source']))
            with root_handle(ticket['source']) as fd:
                require(stamp(os.fstat(fd))[:2]==ticket['manifest']['root'][:2],'SOURCE_CHANGED')
            index['roots'].append({'ticketId':ticket['id'],'source':ticket['source'],'identity':ticket['manifest']['root'][:2]})
            # An interrupted grant leaves conservative lineage, never a ticket
            # whose original can be forgotten after expiry or a restart.
            save_lineage(base,index)
        else: protect_originals(index,ticket['destination'])
        write_new(base/'tickets'/ticket['tokenHash'],ticket)


class Transfers:
    def __init__(self,broker):
        self.broker=broker; self.db=broker.journal.db; self.root=Path(broker.docker.storage)/'runtime/transfers'
        self.threads={}; self.cancelled=set(); self.heartbeats={}
        self.db.execute('CREATE TABLE IF NOT EXISTS transfer_identity(id TEXT NOT NULL)')
        found=self.db.execute('SELECT id FROM transfer_identity').fetchall()
        require(len(found)<=1,'TRANSFER_JOURNAL_CHANGED')
        self.new_journal=not found
        self.journal_id=found[0][0] if found else str(uuid.uuid4())
        if not found:
            with self.db:self.db.execute('INSERT INTO transfer_identity VALUES (?)',(self.journal_id,))
        self.db.execute('CREATE TABLE IF NOT EXISTS transfers(id TEXT PRIMARY KEY,data TEXT NOT NULL)')
        self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS transfer_token ON transfers(json_extract(data,'$.tokenHash'))")
        self.db.execute("CREATE INDEX IF NOT EXISTS transfer_project ON transfers(json_extract(data,'$.project'),json_extract(data,'$.kind'),json_extract(data,'$.phase'))")
        for (transfer_id,) in self.db.execute('SELECT id FROM transfers').fetchall():
            raw=self.db.execute('SELECT data FROM transfers WHERE id=?',(transfer_id,)).fetchone()[0]
            row=json.loads(raw)
            if row['phase'] not in TERMINAL:
                row.update(phase='uncertain',code='BROKER_RESTARTED',residue=True)
                self.save(row)

    def verify_journal(self):
        with lineage_lock(self.root):
            marker=self.root/'identity'
            if marker.exists():
                index=lineage(self.root,self.broker.docker.storage_id)
                require(not self.new_journal and index['journalId']==self.journal_id,'TRANSFER_JOURNAL_CHANGED')
            else:
                require(self.new_journal and self.count()==0 and not any((self.root/'tickets').iterdir()) and not (self.root/'origins.json').exists(),'TRANSFER_JOURNAL_CHANGED')
                identity={'journalId':self.journal_id,'storageId':self.broker.docker.storage_id,'lineageId':str(uuid.uuid4())}
                write_new(marker,identity)
                write_new(self.root/'origins.json',{**identity,'roots':[]})
            self.new_journal=False

    def save(self,row):
        with self.db:
            self.db.execute('INSERT INTO transfers VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',(row['id'],canonical(row)))

    def count(self):
        return self.db.execute('SELECT count(*) FROM transfers').fetchone()[0]

    def find(self,digest):
        found=self.db.execute("SELECT data FROM transfers WHERE json_extract(data,'$.tokenHash')=?",(digest,)).fetchone()
        return json.loads(found[0]) if found else None

    def busy(self,project):
        return self.db.execute("SELECT 1 FROM transfers WHERE json_extract(data,'$.project')=? AND json_extract(data,'$.kind')='export' AND json_extract(data,'$.phase') NOT IN ('succeeded','failed','cancelled','uncertain') LIMIT 1",(project,)).fetchone() is not None

    def idle(self,project):
        require(not self.broker.packages.busy(project), 'INSTALL_RECOVERY_REQUIRED')
        require(not any(json.loads(raw)['project']==project and json.loads(raw)['state'] in ('prepared','accepted','running','uncertain') for (raw,) in self.db.execute('SELECT data FROM claims')), 'PROJECT_BUSY')
        require(not any(value.get('project')==project for value in self.broker.docker.contexts.values()), 'WORKER_NOT_DRAINED')

    def public(self,row):
        return {key:row[key] for key in ('id','kind','project','phase','code','residue','manifestDigest','files','bytes','excludedCount','excluded','history','storageId','sessionId','identity')}

    def get(self,token):
        require(type(token) is str and HEX.fullmatch(token), 'INVALID_TRANSFER_CODE')
        digest=hashlib.sha256(token.encode()).hexdigest()
        row=self.find(digest)
        if row is not None: return row
        raise ValueError('Unknown transfer')

    def dispatch(self,op,body):
        exact(body,['code','kind','project'] if op=='transfer_begin' else ['code','project','sessionId','transferId','manifestDigest'] if op=='transfer_release' else ['code'])
        token=body['code']
        require(type(token) is str and HEX.fullmatch(token), 'INVALID_TRANSFER_CODE')
        if op=='transfer_begin':
            with lineage_lock(self.root):
                row=self.begin(body,token)
            self.heartbeats[row['id']]=time.monotonic()
            thread=threading.Thread(target=self.run,args=(row,),daemon=True)
            self.threads[row['id']]=thread;thread.start()
            return self.public(row)
        if op=='transfer_release':
            digest=hashlib.sha256(token.encode()).hexdigest()
            found=self.find(digest)
            rows=[found] if found else []
            ticket=rows[0] if rows else private_json(self.root/'tickets'/digest)
            require(ticket['journalId']==self.journal_id and ticket['kind']=='export' and ticket['project']==body['project'] and ticket['storageId']==self.broker.docker.storage_id and ticket['sessionId']==body['sessionId'],'TRANSFER_TARGET_MISMATCH')
            require(body['transferId'] is None or body['transferId']==ticket['id'],'TRANSFER_TARGET_MISMATCH')
            require(body['manifestDigest'] is None or body['manifestDigest']==ticket['manifest']['digest'],'TRANSFER_TARGET_MISMATCH')
            with root_handle(self.broker.docker.storage) as storage:
                require(stamp(os.fstat(storage))[:2]==ticket['storageStamp'],'STORAGE_CHANGED')
            if rows:
                thread=self.threads.get(ticket['id'])
                require(ticket['phase'] in TERMINAL and (thread is None or not thread.is_alive()),'TRANSFER_STILL_ACTIVE')
            else:
                # Consume even an unused ticket: explicit release cannot leave a reusable copy grant.
                row={**ticket,'phase':'cancelled','code':'NOT_STARTED','residue':False,'manifestDigest':ticket['manifest']['digest'],'files':0,'bytes':0,'excludedCount':0,'excluded':[],'history':ticket['manifest']['history'],'identity':None}
                require(self.count()<MAX_RECORDS,'TRANSFER_RECORD_CAPACITY');self.save(row)
            return {'released':True,'receipt':self.public(ticket) if rows and ticket['code']!='NOT_STARTED' else None}
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
            try:
                with root_handle(row['destination']) as fd:
                    native=row.get('nativeIdentity',row['identity'])
                    require(stamp(os.fstat(fd))[:2]==native, 'TRANSFER_IDENTITY_CHANGED')
                    require(verify_stage(row['destination'],row['manifest'])==native,'TRANSFER_IDENTITY_CHANGED')
                    if os.name=='nt':
                        require(row.get('linuxMapping') is not None,'PROJECT_MAPPING_REQUIRED')
                        require(self.broker.docker.project_identity(row['project'])==row['linuxMapping'],'PROJECT_MAPPING_CHANGED')
                        require(verify_stage(row['destination'],row['manifest'])==native,'TRANSFER_IDENTITY_CHANGED')
                    row['redeemed']=True;self.save(row)
            except Exception:
                if os.name=='nt':
                    row.update(phase='uncertain',code='PROJECT_MAPPING_UNCERTAIN',residue=True);self.save(row)
                raise
            return self.public(row)
        raise ValueError('Unknown transfer operation')

    def begin(self,body,token):
        digest=hashlib.sha256(token.encode()).hexdigest()
        require(self.find(digest) is None, 'TRANSFER_ALREADY_CONSUMED')
        require(self.count()<MAX_RECORDS, 'TRANSFER_RECORD_CAPACITY')
        ticket=private_json(self.root/'tickets'/digest)
        require(ticket['journalId']==self.journal_id and ticket['tokenHash']==digest and ticket['storageId']==self.broker.docker.storage_id and ticket['sessionId']==self.broker.journal.session and ticket['expiresAt']>now(), 'TRANSFER_TICKET_EXPIRED')
        require(body['kind']==ticket['kind'] and (body['project'] is None if ticket['kind']=='import' else body['project']==ticket['project']), 'TRANSFER_TARGET_MISMATCH')
        verify_lineage_ticket(lineage(self.root,self.broker.docker.storage_id),ticket)
        if ticket['kind']=='export':
            require(not self.busy(ticket['project']), 'TRANSFER_BUSY')
            self.idle(ticket['project'])
        row={**ticket,'phase':'copying','code':'COPYING','residue':True,'manifestDigest':ticket['manifest']['digest'],
             'files':sum(i['kind']=='file' for i in ticket['manifest']['entries']),'bytes':ticket['manifest']['bytes'],
             'excludedCount':len(ticket['manifest']['excluded']),'excluded':ticket['manifest']['excluded'][:100],
             'history':ticket['manifest']['history'],'identity':None}
        self.save(row) # Durable consumption before thread or filesystem effect.
        return row

    def run(self,row):
        try:
            with lineage_lock(self.root,wait=True):
                verify_lineage_ticket(lineage(self.root,self.broker.docker.storage_id),row)
                self.run_locked(row)
        except Exception as error:
            with self.broker.lock:
                row.update(phase='failed' if row['phase']=='copying' else 'uncertain',code=str(error) if isinstance(error,Denied) else 'TRANSFER_INCOMPLETE',residue=True)
                self.save(row)

    def run_locked(self,row):
        def check():
            with self.broker.lock:
                barrier=getattr(self.broker.docker,'storage_barrier',None)
                if barrier:barrier()
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
            verify_source_metadata(row['source'],row['manifest'],check)
            with self.broker.lock:
                check()
                with root_handle(Path(row['destination']).parent) as parent:
                    require(stamp(os.fstat(parent))[:2]==row['destinationParent'],'DESTINATION_CHANGED')
                verify_lineage_ticket(lineage(self.root,self.broker.docker.storage_id),row)
                row.update(phase='publishing',code='PUBLISHING');self.save(row)
                publish(stage,Path(row['destination']),stage_identity,row['destinationParent'])
                with root_handle(row['destination']) as fd:
                    published_identity=stamp(os.fstat(fd))[:2]
                    row['identity']=None if os.name=='nt' else published_identity
                    if os.name=='nt' and row['kind']=='import':
                        row['nativeIdentity']=published_identity
                        require(verify_stage(row['destination'],row['manifest'])==row['nativeIdentity'],'TRANSFER_IDENTITY_CHANGED')
                        row['linuxMapping']=self.broker.docker.project_identity(row['project'])
                        require(verify_stage(row['destination'],row['manifest'])==row['nativeIdentity'],'TRANSFER_IDENTITY_CHANGED')
                        row['identity']=row['linuxMapping']['identity']
                check()
                row.update(phase='succeeded',code='COMPLETE_WITH_EXCLUSIONS' if row['excludedCount'] else 'COMPLETE',residue=False)
                self.save(row)
        except Exception as error:
            with self.broker.lock:
                # A publication or commit failure may have left a complete destination.
                row.update(phase='failed' if isinstance(error,FileExistsError) else 'uncertain' if row['phase']=='publishing' else 'cancelled' if row['id'] in self.cancelled else 'failed',code=str(error) if isinstance(error,Denied) else 'DESTINATION_EXISTS' if isinstance(error,FileExistsError) else 'TRANSFER_INCOMPLETE',residue=True)
                self.save(row)

    def close(self):
        with self.broker.lock:
            self.cancelled.update(self.threads)
            threads=list(self.threads.values())
        for thread in threads:
            thread.join(timeout=30)
            require(not thread.is_alive(),'TRANSFER_DRAIN_UNCERTAIN')
