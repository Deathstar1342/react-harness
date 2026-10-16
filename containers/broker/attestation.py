"""Host-side image attestation. Exported bytes are hashed, never extracted/executed."""
import hashlib
import json
from pathlib import PurePosixPath
import subprocess
import tarfile
import time
import threading
from protocol import require, digest

EXPORT_SECONDS = 300
TREES = ('usr/lib/python3.11', 'usr/lib/python3/dist-packages', 'usr/local/lib/python3.11',
         'usr/lib/x86_64-linux-gnu', 'usr/lib/git-core', 'usr/share/git-core',
         'usr/local/lib/node_modules', 'opt/abyssus-worker', 'opt/abyssus-packages',
         'etc/ld.so.conf.d')
FILES = {'usr/bin/python3', 'usr/bin/python3.11', 'usr/bin/git', 'usr/local/bin/node',
         'etc/ld.so.cache', 'etc/ld.so.conf', 'etc/ld.so.preload', 'lib', 'lib64', 'bin', 'sbin',
         'usr/lib/abyssus-helper/apt.conf', 'usr/lib/abyssus-helper/empty-apt-config'}
PARENTS = {str(parent) for item in (*TREES, *FILES) for parent in PurePosixPath(item).parents if str(parent) != '.'}

def normalized(name):
    name = name.rstrip('/')
    require(len(name.encode('utf-8', errors='strict')) <= 4096 and not any(ord(c) < 32 for c in name), 'UNSAFE_IMAGE_PATH')
    require(name and not name.startswith('/') and '\\' not in name and '\0' not in name, 'UNSAFE_IMAGE_PATH')
    require(all(part not in ('', '.', '..') for part in name.split('/')), 'UNSAFE_IMAGE_PATH')
    return name

def protected(name):
    return name in FILES or name in PARENTS or any(name == tree or name.startswith(tree + '/') for tree in TREES)

def manifest(stream, max_bytes=8 * 1024**3, max_members=500000, deadline=None):
    deadline = deadline or time.monotonic() + 300
    seen = set()
    files = {}
    links = {}
    selected = {}
    total = 0
    with tarfile.open(fileobj=stream, mode='r|') as archive:
        for item in archive:
            require(time.monotonic() < deadline, 'IMAGE_ATTESTATION_TIMEOUT')
            name = normalized(item.name)
            require(name not in seen and len(seen) < max_members, 'IMAGE_DUPLICATE_OR_LIMIT')
            seen.add(name)
            total += item.size
            require(0 <= item.size <= 512 * 1024**2 and total <= max_bytes, 'IMAGE_BYTE_LIMIT')
            entry = {'mode': item.mode, 'uid': item.uid, 'gid': item.gid}
            if item.isfile():
                h = hashlib.sha256()
                source = archive.extractfile(item)
                count = 0
                while True:
                    block = source.read(1024 * 1024)
                    if not block:
                        break
                    count += len(block)
                    h.update(block)
                    require(time.monotonic() < deadline, 'IMAGE_ATTESTATION_TIMEOUT')
                require(count == item.size, 'IMAGE_TRUNCATED')
                entry.update(kind='file', sha256=h.hexdigest(), size=item.size)
                files[name] = entry
            elif item.isdir():
                entry['kind'] = 'directory'
            elif item.issym():
                target = item.linkname
                require('\0' not in target and '\\' not in target, 'UNSAFE_IMAGE_LINK')
                parts = [] if target.startswith('/') else name.split('/')[:-1]
                for part in target.split('/'):
                    if part in ('', '.'):
                        continue
                    if part == '..':
                        require(bool(parts), 'UNSAFE_IMAGE_LINK')
                        parts.pop()
                    else:
                        parts.append(part)
                entry.update(kind='symlink', target=target)
            elif item.islnk():
                links[name] = normalized(item.linkname)
                entry.update(kind='hardlink', target=links[name])
            else:
                require(not protected(name), 'UNSAFE_TRUSTED_MEMBER')
                entry['kind'] = 'special'
            if protected(name):
                selected[name] = entry
    for name, target in links.items():
        require(target in files, 'UNRESOLVED_IMAGE_HARDLINK')
        if name in selected:
            require(protected(target), 'UNTRUSTED_IMAGE_HARDLINK')
            selected[name]['targetDigest'] = digest(files[target])
    for essential in ('usr/bin/python3.11', 'usr/lib/python3.11', 'usr/bin/git', 'usr/lib/x86_64-linux-gnu', 'opt/abyssus-worker/worker-runner.py'):
        require(essential in selected, 'TRUSTED_IMAGE_ROOT_MISSING')
    return selected

class Attestor:
    def __init__(self, docker):
        self.docker = docker
        self.expected_env = json.loads(docker.call(['image','inspect',docker.image]))[0]['Config'].get('Env',[])
        require(not any(item.split('=',1)[0] in ('LD_PRELOAD','LD_LIBRARY_PATH','PYTHONPATH','PYTHONHOME','BASH_ENV','ENV') for item in self.expected_env), 'IMAGE_ENV_INJECTION')
        self.base = self.inspect(docker.image)
        for member,source in [('opt/abyssus-worker/worker-runner.py','containers/worker-runner.py'),('opt/abyssus-worker/worker-bridge.py','containers/worker-bridge.py'),('opt/abyssus-worker/broker/egress.py','containers/broker/egress.py'),('opt/abyssus-packages/apt_adapter.py','helper/apt_adapter.py'),('opt/abyssus-packages/core.py','helper/core.py'),('opt/abyssus-packages/container-apt.py','containers/container-apt.py')]:
            require(self.base.get(member,{}).get('sha256') == hashlib.sha256((docker.source / source).read_bytes()).hexdigest(), 'IMAGE_SOURCE_MISMATCH')
        self.base_digest = digest(self.base)
        self.verified = {docker.image: self.base_digest}

    def inspect(self, image):
        info = json.loads(self.docker.call(['image', 'inspect', image]))[0]
        require(info['Id'] == image and not info['Config'].get('Volumes') and info['Config'].get('Env',[]) == self.expected_env, 'IMAGE_CONTROL_METADATA')
        require(info.get('Architecture') == 'amd64' and info.get('Os') == 'linux', 'IMAGE_PLATFORM')
        container = self.docker.resources.create(['--network', 'none', '--entrypoint', '/usr/bin/true', image], image, 'attestation')
        process = None
        watchdog = None
        timed_out = threading.Event()
        try:
            process = subprocess.Popen(self.docker.argv(['export', container]), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=self.docker.env)
            def expire():
                timed_out.set()
                process.kill()
            watchdog = threading.Timer(EXPORT_SECONDS, expire)
            watchdog.daemon = True
            watchdog.start()
            result = manifest(process.stdout)
            require(process.wait(timeout=10) == 0 and not timed_out.is_set(), 'IMAGE_EXPORT_FAILED')
            return result
        finally:
            if watchdog is not None:
                watchdog.cancel()
            if process is not None:
                if process.poll() is None:
                    process.kill()
                process.stdout.close()
            # A failed cleanup prevents the caller from receiving any attestation.
            self.docker.resources.remove(container)

    def verify(self, image):
        if image not in self.verified:
            current = self.inspect(image)
            self.last_difference = [name for name in sorted(set(current)|set(self.base)) if current.get(name)!=self.base.get(name)][:64]
            require(current == self.base, 'TRUSTED_EXECUTION_BASE_CHANGED')
            self.verified[image] = self.base_digest
        return {'imageId': image, 'baseImageId': self.docker.image, 'manifestDigest': self.verified[image]}
