"""Fixed private target metadata validator; no contents or workspace grants."""
import contextlib
from pathlib import Path
import re
from protocol import exact,require,digest
from windows_handles import PinnedPath

ROOTS=('state','config','control')
KINDS=('file','directory','sqlite')
TRANSIENTS=('-journal','-wal','-shm')


def validate_targets(targets):
    require(type(targets) is list and 1<=len(targets)<=8,'PRIVATE_TARGET_LIMIT');seen=set()
    for value in targets:
        exact(value,['root','relative','kind','mode'])
        require(value['root'] in ROOTS and value['kind'] in KINDS and value['mode'] in ('existing','create'),'PRIVATE_TARGET_CLASS')
        relative=value['relative']
        require(type(relative) is str and not any(0xD800<=ord(c)<=0xDFFF for c in relative) and len(relative.encode('utf-8'))<=1024 and len(relative.split('/'))<=64,'PRIVATE_TARGET_PATH')
        require(bool(relative) or value['kind']=='directory' and value['mode']=='existing','PRIVATE_TARGET_PATH')
        for part in relative.split('/') if relative else []:
            require(part not in ('','.','..') and len(part)<=240 and not re.search(r'[\\:\x00-\x1f<>"|?*]',part) and not part.endswith((' ','.')),'PRIVATE_TARGET_PATH')
            require(not re.fullmatch(r'(?i)(?:con|conin\$|conout\$|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\..*)?',part),'PRIVATE_TARGET_PATH')
        require(value['kind']!='sqlite' or relative.endswith('.sqlite'),'PRIVATE_SQLITE_TARGET')
        key=(value['root'],relative.casefold());require(key not in seen,'PRIVATE_TARGET_DUPLICATE');seen.add(key)
    return digest(targets)


def target_digest(targets,binding,session,phase):
    validate_targets(targets)
    require(phase in ('initialize','controller'),'PRIVATE_TARGET_PHASE')
    return digest({'targets':targets,'phase':phase,'storageId':binding['storageId'],'launchId':binding['launchId'],'sessionId':session})


def missing(error):
    return isinstance(error,FileNotFoundError) and (error.errno in (2,3) or getattr(error,'winerror',None) in (2,3))


class PrivateTargets:
    """Host-only session identity ledger for stable SQLite database targets."""
    def __init__(self,guard):self.guard=guard;self.databases={};self.failed=False
    def observe(self,targets):
        require(not self.failed,'PRIVATE_TARGET_RECOVERY_REQUIRED');validate_targets(targets)
        try:
            retained=dict(self.databases);result=verify_targets(self.guard,targets,retained)
            self.databases=retained;return result
        except BaseException:self.failed=True;raise


def verify_targets(guard,targets,databases=None):
    identity=validate_targets(targets);guard.verify_roots()
    for value in targets:
        root=Path(guard.pins[value['root']].path);target=root.joinpath(*value['relative'].split('/'));key=(value['root'],value['relative'].casefold())
        with contextlib.ExitStack() as pins:
            # Hold opened parents until every exact target check completes.
            parent=root;parent_pin=guard.pins[value['root']]
            for part in value['relative'].split('/')[:-1]:
                parent=parent/part
                try:parent_pin=pins.enter_context(PinnedPath(parent,directory=True));parent_pin.private()
                except OSError as error:
                    if not missing(error) or value['mode']!='create' or databases is not None and key in databases:raise
                    break
            else:
                pin=None
                try:
                    pin=pins.enter_context(PinnedPath(target,directory=value['kind']=='directory',share_write=True));pin.private()
                    if value['kind']=='sqlite' and databases is not None:
                        current=(pin.identity['volume'],pin.identity['fileId']);require(key not in databases or databases[key]==current,'PRIVATE_DATABASE_CHANGED')
                        require(key in databases or len(databases)<64,'PRIVATE_DATABASE_LIMIT');databases[key]=current
                except OSError as error:
                    if not missing(error) or value['mode']!='create' or databases is not None and key in databases:raise
                if value['kind']=='sqlite' and pin is not None:
                    from sqlite_auxiliary import observe_auxiliary
                    for suffix in TRANSIENTS:
                        observe_auxiliary(pin,parent_pin,suffix)
            guard.verify_roots()
    return identity
