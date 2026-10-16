"""Trusted-host copy policy. Never execute Git or follow a selected tree's links.

Linux descriptor-relative traversal is the supported source implementation. Other
host transports must provide equivalent handle semantics before enabling copies.
"""
import contextlib
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
import unicodedata
from protocol import Denied, require, canonical

MAX_ENTRIES = 50000
MAX_BYTES = 2 * 1024**3
MAX_FILE = 256 * 1024**2
MAX_DEPTH = 32
MAX_PATH = 240
CACHE = {"node_modules", ".venv", "venv", "__pycache__", ".cache", ".next", ".nuxt", "dist", "build", "target", "coverage", ".pytest_cache", ".mypy_cache", ".tox"}
NEVER = {".config", ".docker", ".kube", "application_default_credentials.json", ".aws", ".azure", ".ssh", ".gnupg", ".codex", ".harness", ".container-source", ".storage-id", "state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "worker-journal.sqlite", "session.json", ".gitmodules"}
SENSITIVE = {".env", ".npmrc", ".pypirc", ".netrc", "credentials", "credentials.json", "secrets.json", "id_rsa", "id_ed25519"}
GIT_BAD = {"alternates", "http-alternates", "commondir", "gitdir", "modules", "worktrees", "grafts", "replace"}
GIT_ROOT = {"objects", "refs", "HEAD", "index", "packed-refs", "shallow"}
GIT_CONFIG = b'[core]\n\trepositoryformatversion = 0\n\tbare = false\n\thooksPath = /dev/null\n'


def component(value):
    require(type(value) is str and value not in ('', '.', '..'), 'UNSAFE_NAME')
    require(value == unicodedata.normalize('NFC', value), 'UNSAFE_UNICODE_NAME')
    require(not re.search(r'[\x00-\x1f\x7f<>:"/\\|?*]', value) and not value.endswith(('.', ' ')), 'UNSAFE_NAME')
    require(not re.match(r'(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', value), 'WINDOWS_RESERVED_NAME')
    require(len(value.encode('utf8')) <= 120, 'PATH_LIMIT')
    return value.casefold()


def relative(value):
    parts = value.split('/')
    require(len(parts) <= MAX_DEPTH and len(value.encode('utf8')) <= MAX_PATH, 'PATH_LIMIT')
    for part in parts:
        component(part)
    return parts


def stamp(info):
    return [str(info.st_dev), str(info.st_ino), info.st_mode, info.st_nlink, info.st_size, str(info.st_mtime_ns), str(info.st_ctime_ns)]


def policy(rel, included, history):
    parts = relative(rel)
    lower = [p.casefold() for p in parts]
    require('.gitmodules' not in lower,'UNSAFE_GIT_METADATA')
    if '.git' in lower:
        require(lower.index('.git')==0 and parts[0]=='.git' and lower.count('.git')==1,'UNSAFE_GIT_METADATA')
    if any(p in NEVER for p in lower):
        return 'Application or credential storage is never included'
    if lower[0] == '.git':
        if not history:
            return 'Git history was not explicitly included'
        require(not any(p in GIT_BAD for p in lower[1:]), 'UNSAFE_GIT_METADATA')
        if len(parts) > 1 and parts[1] not in GIT_ROOT:
            return 'Git hooks, configuration and ancillary metadata are excluded'
        if len(parts) > 2 and parts[1] == 'objects':
            if parts[2] == 'info':
                return 'Git auxiliary object metadata is omitted'
            require(parts[2] == 'pack' or re.fullmatch('[a-f0-9]{2}', parts[2]), 'UNSAFE_GIT_OBJECT_LAYOUT')
        return None
    if any(p in CACHE for p in lower):
        return 'Dependency, build or cache directory'
    sensitive = any(p in SENSITIVE or p.startswith('.env.') or p.endswith(('.pem', '.key', '.p12', '.pfx')) for p in lower)
    if sensitive and rel not in included:
        return 'Sensitive project file; explicit host inclusion required'
    return None


@contextlib.contextmanager
def root_handle(root):
    require(os.name == 'posix' and hasattr(os, 'O_NOFOLLOW'), 'TRANSFER_PLATFORM_UNSUPPORTED')
    root = str(root)
    require(root.startswith('/') and os.path.normpath(root) == root and root != '/', 'UNSAFE_ROOT')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for name in root.split('/')[1:]:
            new = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = new
        yield fd
    finally:
        os.close(fd)


@contextlib.contextmanager
def entry_handle(rootfd, rel, directory=False):
    parts = relative(rel)
    fd = os.dup(rootfd)
    try:
        for i, name in enumerate(parts):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if i < len(parts) - 1 or directory:
                flags |= os.O_DIRECTORY
            new = os.open(name, flags, dir_fd=fd)
            os.close(fd)
            fd = new
        yield fd
    finally:
        os.close(fd)


def check_file(info, device):
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_dev == device, 'LINK_OR_SPECIAL_FILE')
    require(info.st_size <= MAX_FILE, 'FILE_LIMIT')


def mounts_under(root):
    if not Path('/proc/self/mountinfo').exists():
        return
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        mount = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), line.split()[4])
        require(not mount.startswith(str(root) + '/'), 'NESTED_MOUNT')


def scan(root, included=(), history=False, secrets=(), check=lambda: None):
    """Retain exclusions in the bounded manifest; hashes bind every included byte."""
    included = list(included)
    require(len(included) <= 100 and len(set(included)) == len(included), 'INCLUSION_LIMIT')
    for item in included:
        relative(item)
    result = {'entries': [], 'excluded': [], 'bytes': 0, 'history': history, 'included': included}
    count = 0
    mounts_under(root)
    validate_git(root,check)
    with root_handle(root) as rootfd:
        rootinfo = os.fstat(rootfd)
        result['root'] = stamp(rootinfo)
        def walk(fd, prefix=''):
            nonlocal count
            before = stamp(os.fstat(fd))
            names = []
            with os.scandir(fd) as listing:
                for entry in listing:
                    require(len(names) + count < MAX_ENTRIES, 'ENTRY_LIMIT')
                    names.append(entry.name)
            names.sort()
            folded = set()
            for name in names:
                check()
                count += 1
                require(count <= MAX_ENTRIES, 'ENTRY_LIMIT')
                collision = component(name)
                require(collision not in folded, 'CASE_COLLISION')
                folded.add(collision)
                rel = prefix + name
                relative(rel)
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                require(not stat.S_ISLNK(info.st_mode), 'LINK_OR_SPECIAL_FILE')
                require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode), 'LINK_OR_SPECIAL_FILE')
                require(info.st_dev == rootinfo.st_dev, 'NESTED_MOUNT')
                if stat.S_ISREG(info.st_mode):
                    require(info.st_nlink == 1, 'LINK_OR_SPECIAL_FILE')
                if rel == '.git':
                    require(stat.S_ISDIR(info.st_mode), 'GIT_INDIRECTION')
                # Unsafe Git topology is rejected even when history is omitted.
                if rel == '.git' or prefix.startswith('.git/'):
                    require(name not in GIT_BAD, 'UNSAFE_GIT_METADATA')
                reason = policy(rel, included, history)
                if reason:
                    result['excluded'].append({'path': rel, 'reason': reason})
                    continue
                if stat.S_ISDIR(info.st_mode):
                    with entry_handle(rootfd, rel, True) as child:
                        require(stamp(os.fstat(child)) == stamp(info), 'SOURCE_CHANGED')
                        result['entries'].append({'path': rel, 'kind': 'directory', 'stamp': stamp(info)})
                        walk(child, rel + '/')
                else:
                    check_file(info, rootinfo.st_dev)
                    result['bytes'] += info.st_size
                    require(result['bytes'] <= MAX_BYTES, 'BYTE_LIMIT')
                    with entry_handle(rootfd, rel) as file:
                        require(stamp(os.fstat(file)) == stamp(info), 'SOURCE_CHANGED')
                        digest = hash_stream(file, secrets, check)
                        require(stamp(os.fstat(file)) == stamp(info), 'SOURCE_CHANGED')
                    result['entries'].append({'path': rel, 'kind': 'file', 'stamp': stamp(info), 'hash': digest})
            require(stamp(os.fstat(fd)) == before and sorted(os.listdir(fd)) == names, 'SOURCE_CHANGED')
        walk(rootfd)
        require(stamp(os.fstat(rootfd)) == result['root'], 'SOURCE_CHANGED')
    with root_handle(root) as current:
        require(stamp(os.fstat(current)) == result['root'], 'SOURCE_CHANGED')
    result['digest'] = hashlib.sha256(canonical(result).encode()).hexdigest()
    return result


def hash_stream(fd, secrets, check, output=None):
    digest = hashlib.sha256()
    tail = b''
    needles = [v.encode() if isinstance(v, str) else v for v in secrets if len(v) >= 4]
    longest = max([len(v) for v in needles] + [1])
    total = 0
    while True:
        check()
        block = os.read(fd, 1024**2)
        if not block:
            break
        total += len(block)
        require(total <= MAX_FILE, 'FILE_LIMIT')
        require(not any(v in tail + block for v in needles), 'APPLICATION_SECRET_FOUND')
        tail = (tail + block)[-(longest - 1):] if longest > 1 else b''
        digest.update(block)
        if output is not None:
            view = memoryview(block)
            while view:
                written = os.write(output, view)
                require(written > 0, 'COPY_FAILED')
                view = view[written:]
    return digest.hexdigest()


def fsync_dir(path):
    with root_handle(path) as fd:
        os.fsync(fd)


def copy(root, stage, manifest, secrets=(), check=lambda: None, parent_identity=None):
    """Stage must be newly allocated by the trusted owner, outside worker mounts."""
    stage = Path(stage)
    with root_handle(stage.parent) as parent:
        if parent_identity is not None:
            require(stamp(os.fstat(parent))[:2] == parent_identity, 'DESTINATION_CHANGED')
        os.mkdir(stage.name, mode=0o700, dir_fd=parent)
        created = os.stat(stage.name, dir_fd=parent, follow_symlinks=False)
    with root_handle(root) as source, root_handle(stage) as target:
        require(stamp(os.fstat(target)) == stamp(created), 'STAGE_CHANGED')
        require(stamp(os.fstat(source)) == manifest['root'], 'SOURCE_CHANGED')
        for item in manifest['entries']:
            check()
            rel = item['path']
            parent, _, name = rel.rpartition('/')
            with contextlib.ExitStack() as stack:
                outparent = stack.enter_context(entry_handle(target, parent, True)) if parent else target
                if item['kind'] == 'directory':
                    os.mkdir(name, mode=0o700, dir_fd=outparent)
                    continue
                infile = stack.enter_context(entry_handle(source, rel))
                require(stamp(os.fstat(infile)) == item['stamp'], 'SOURCE_CHANGED')
                outfile = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=outparent)
                try:
                    require(hash_stream(infile, secrets, check, outfile) == item['hash'], 'SOURCE_CHANGED')
                    require(stamp(os.fstat(infile)) == item['stamp'], 'SOURCE_CHANGED')
                    os.fchmod(outfile, 0o700 if item['stamp'][2] & 0o111 else 0o600)
                    os.utime(outfile, ns=(int(item['stamp'][5]), int(item['stamp'][5])))
                    os.fsync(outfile)
                finally:
                    os.close(outfile)
        if not any(i['path'] == '.git' for i in manifest['entries']):
            os.mkdir('.git', mode=0o700, dir_fd=target)
            with entry_handle(target, '.git', True) as git:
                for name in ('objects', 'refs'):
                    os.mkdir(name, mode=0o700, dir_fd=git)
                fd = os.open('HEAD', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=git)
                os.write(fd, b'ref: refs/heads/main\n')
                os.fsync(fd)
                os.close(fd)
        if True:
            with entry_handle(target, '.git', True) as git:
                fd = os.open('config', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=git)
                try:
                    os.write(fd, GIT_CONFIG)
                    os.fsync(fd)
                    os.fsync(git)
                finally:
                    os.close(fd)
        for item in reversed(manifest['entries']):
            if item['kind'] == 'directory':
                with entry_handle(target, item['path'], True) as directory:
                    os.fsync(directory)
        os.fsync(target)
    # Re-read all selected bytes and directory identities. No torn source is published.
    require(scan(root, manifest['included'], manifest['history'], secrets, check) == manifest, 'SOURCE_CHANGED')


def publish(stage, destination, stage_identity=None, parent_identity=None):
    """Atomic no-replace, including empty destination directories; never merge."""
    stage, destination = Path(stage), Path(destination)
    component(destination.name)
    with root_handle(stage.parent) as parent, root_handle(destination.parent) as target:
        if parent_identity is not None:
            require(stamp(os.fstat(target))[:2] == parent_identity, 'DESTINATION_CHANGED')
        if stage_identity is not None:
            require(stamp(os.stat(stage.name, dir_fd=parent, follow_symlinks=False))[:2] == stage_identity, 'STAGE_CHANGED')
        rename = ctypes.CDLL(None, use_errno=True).renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        if rename(parent, os.fsencode(stage.name), target, os.fsencode(destination.name), 1) != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        os.fsync(parent)
        os.fsync(target)

def validate_git(root, check=lambda: None):
    """Inspect metadata as bytes only. Never evaluate config, hooks or Git tree paths."""
    with root_handle(root) as base:
        try: info=os.stat('.git',dir_fd=base,follow_symlinks=False)
        except FileNotFoundError: return
        require(stat.S_ISDIR(info.st_mode),'GIT_INDIRECTION')
        count=0; total=0
        def walk(fd,prefix):
            nonlocal count,total
            with os.scandir(fd) as listing:
                names=[]
                for entry in listing:
                    count+=1;require(count<=MAX_ENTRIES,'GIT_ENTRY_LIMIT');names.append(entry.name)
            folded=set()
            for name in names:
                check();key=component(name);require(key not in folded,'CASE_COLLISION');folded.add(key)
                rel=prefix+'/'+name;relative(rel)
                require(name not in GIT_BAD,'UNSAFE_GIT_METADATA')
                item=os.stat(name,dir_fd=fd,follow_symlinks=False)
                require(item.st_dev==info.st_dev,'NESTED_MOUNT')
                if stat.S_ISDIR(item.st_mode):
                    with entry_handle(base,rel,True) as child: walk(child,rel)
                else:
                    check_file(item,info.st_dev)
                    total+=item.st_size;require(total<=MAX_BYTES,'GIT_BYTE_LIMIT')
                    if rel=='.git/config':
                        require(item.st_size<=65536,'GIT_CONFIG_LIMIT')
                        with entry_handle(base,rel) as file: content=os.read(file,65537).decode('utf8')
                        import configparser
                        config=configparser.ConfigParser(interpolation=None,strict=True)
                        try: config.read_string(content)
                        except Exception: raise Denied('UNSAFE_GIT_CONFIG') from None
                        require(not config.has_section('extensions') and config.get('core','repositoryformatversion',fallback='0')=='0' and not config.has_option('core','worktree') and config.get('core','bare',fallback='false').lower()=='false','UNSUPPORTED_GIT_LAYOUT')
                    elif rel=='.git/HEAD' or rel.startswith('.git/refs/') or rel in ('.git/packed-refs','.git/shallow'):
                        require(item.st_size<=1024**2,'GIT_REFS_LIMIT')
                        with entry_handle(base,rel) as file: data=os.read(file,1024**2+1)
                        try: lines=data.decode('ascii').splitlines()
                        except UnicodeError: raise Denied('INVALID_GIT_REF') from None
                        if rel=='.git/HEAD':
                            require(len(lines)==1 and bool(re.fullmatch(r'(?:[a-f0-9]{40}|ref: refs/(?:heads|tags)/[A-Za-z0-9_./-]+)',lines[0])),'INVALID_GIT_HEAD')
                            if lines[0].startswith('ref: '): relative(lines[0][5:])
                        else:
                            for line in lines:
                                if rel=='.git/packed-refs':
                                    require(line.startswith('# pack-refs with:') or bool(re.fullmatch(r'\^?[a-f0-9]{40}(?: refs/(?:heads|tags|remotes)/[A-Za-z0-9_./-]+)?',line)),'INVALID_GIT_REF')
                                    if ' refs/' in line: relative(line.split(' ',1)[1])
                                else: require(bool(re.fullmatch('[a-f0-9]{40}',line)),'INVALID_GIT_REF')
                    elif rel=='.git/index' or rel.startswith('.git/objects/'):
                        if '/objects/info/' in rel: raise Denied('UNSAFE_GIT_METADATA')
                        with entry_handle(base,rel) as file:
                            header=os.read(file,12)
                            if rel=='.git/index':
                                require(len(header)==12 and header[:4]==b'DIRC' and int.from_bytes(header[4:8],'big') in (2,3,4) and int.from_bytes(header[8:12],'big')<=MAX_ENTRIES,'INVALID_GIT_INDEX')
                            elif '/pack/' in rel:
                                require(re.fullmatch(r'pack-[a-f0-9]{40}\.(pack|idx)',name),'UNSUPPORTED_GIT_PACK')
                                require(header[:4] in (b'PACK',b'\xfftOc'),'INVALID_GIT_PACK')
                            else:
                                require(bool(re.fullmatch(r'\.git/objects/[a-f0-9]{2}/[a-f0-9]{38}',rel)),'INVALID_GIT_OBJECT')
                            verify_git_bytes(file,rel,item.st_size)
        with entry_handle(base,'.git',True) as git: walk(git,'.git')


def verify_stage(stage, manifest, check=lambda:None):
    expected={item['path']:item for item in manifest['entries']}
    has_git='.git' in expected
    if not has_git:
        for name in ('.git','.git/objects','.git/refs'): expected[name]={'kind':'directory'}
        expected['.git/HEAD']={'kind':'file','hash':hashlib.sha256(b'ref: refs/heads/main\n').hexdigest()}
    expected['.git/config']={'kind':'file','hash':hashlib.sha256(GIT_CONFIG).hexdigest()}
    seen=set()
    with root_handle(stage) as root:
        identity=stamp(os.fstat(root))[:2]
        def walk(fd,prefix=''):
            with os.scandir(fd) as entries:
                for entry in entries:
                    check();rel=prefix+entry.name
                    require(rel in expected and rel not in seen,'STAGE_CHANGED');seen.add(rel)
                    info=os.stat(entry.name,dir_fd=fd,follow_symlinks=False)
                    if expected[rel]['kind']=='directory':
                        require(stat.S_ISDIR(info.st_mode),'STAGE_CHANGED')
                        with entry_handle(root,rel,True) as child:walk(child,rel+'/')
                    else:
                        check_file(info,os.fstat(root).st_dev)
                        require(info.st_mode&0o7000==0,'UNSAFE_MODE')
                        with entry_handle(root,rel) as file:require(hash_stream(file,(),check)==expected[rel]['hash'],'STAGE_CHANGED')
        walk(root);require(seen==set(expected),'STAGE_CHANGED')
        return identity

def verify_source_metadata(root,manifest,check=lambda:None):
    with root_handle(root) as source:
        require(stamp(os.fstat(source))==manifest['root'],'SOURCE_CHANGED')
        for entry in manifest['entries']:
            check()
            with entry_handle(source,entry['path'],entry['kind']=='directory') as fd:
                require(stamp(os.fstat(fd))==entry['stamp'],'SOURCE_CHANGED')


def verify_git_bytes(fd,rel,size):
    """Bounded integrity checks; no checkout or interpretation of tree paths."""
    os.lseek(fd,0,os.SEEK_SET)
    if re.fullmatch(r'\.git/objects/[a-f0-9]{2}/[a-f0-9]{38}',rel):
        import zlib
        inflater=zlib.decompressobj();digest=hashlib.sha1();count=0;header=b'';body_start=None
        while block:=os.read(fd,1024**2):
            raw=inflater.decompress(block,MAX_FILE-count+1);count+=len(raw)
            require(count<=MAX_FILE and not inflater.unconsumed_tail,'GIT_EXPANSION_LIMIT')
            digest.update(raw)
            if body_start is None:
                header+=raw[:128]
                if b'\0' in header:
                    value=header.split(b'\0',1)[0];body_start=len(value)+1
                    require(re.fullmatch(rb'(blob|tree|commit|tag) [0-9]{1,10}',value),'INVALID_GIT_OBJECT')
                    declared=int(value.split(b' ')[1])
                else:require(len(header)<128,'INVALID_GIT_OBJECT')
        require(inflater.eof and not inflater.unused_data and body_start is not None and count-body_start==declared and digest.hexdigest()==rel.split('/')[-2]+rel.split('/')[-1],'INVALID_GIT_OBJECT')
    elif rel=='.git/index' or re.fullmatch(r'\.git/objects/pack/pack-[a-f0-9]{40}\.(pack|idx)',rel):
        require(size>=32,'INVALID_GIT_METADATA')
        digest=hashlib.sha1();remaining=size-20
        while remaining:
            block=os.read(fd,min(1024**2,remaining));require(bool(block),'SOURCE_CHANGED');remaining-=len(block);digest.update(block)
        require(os.read(fd,20)==digest.digest(),'INVALID_GIT_CHECKSUM')
