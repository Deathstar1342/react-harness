"""Host-only Docker adapter. No socket or executable selection crosses worker wire."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import uuid
from protocol import Denied, require, digest

PROTECTED = re.compile(r'^(?:\.git(?:$|\.)|\.env|\.ssh$|\.aws$|\.azure$|\.docker$|\.kube$|application_default_credentials\.json$|\.config$|\.gnupg$|\.npmrc$|\.netrc$|\.pypirc$|\.gitconfig$|credentials(?:$|\.)|secrets?(?:$|\.)|id_(?:rsa|dsa|ecdsa|ed25519)(?:$|\.))|\.(?:pem|key|p12|pfx|keystore)$', re.I)

class Docker:
    def __init__(self, storage, storage_id, source, context):
        self.storage = Path(storage)
        self.storage_id = storage_id
        self.source = Path(source)
        self.uid, self.gid = os.getuid(), os.getgid()
        require(self.uid > 0 and self.gid > 0, 'NONROOT_HOST_REQUIRED')
        require(self.storage.is_dir() and self.storage.resolve() == self.storage and ',' not in storage, 'UNSAFE_STORAGE')
        require((self.storage / '.storage-id').read_text().strip() == storage_id, 'STORAGE_CHANGED')
        self.env = {k: os.environ[k] for k in ('HOME', 'PATH') if k in os.environ}
        self.env.update(LANG='C.UTF-8')
        self.context = context
        endpoint = self.call(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']).strip()
        require(endpoint.startswith('unix:///') and Path(endpoint[7:]).is_socket(), 'LOCAL_ENGINE_REQUIRED')
        info = json.loads(self.call(['info', '--format', '{{json .}}']))
        require(info['OSType'] == 'linux' and info['Architecture'] in ('x86_64', 'amd64'), 'UNSUPPORTED_ENGINE')
        require(not any('rootless' in str(v) or 'userns' in str(v) for v in info.get('SecurityOptions', [])), 'UNSUPPORTED_UID_MAPPING')
        self.image = self.call(['image', 'inspect', 'abyssus-worker:m29', '--format', '{{.Id}}']).strip()
        require(re.fullmatch(r'sha256:[a-f0-9]{64}', self.image), 'WORKER_IMAGE_MISSING')
        from attestation import Attestor
        self.attestor = Attestor(self)
        self.contexts = {}
        self.images = {}
        self.blank = self.storage / 'runtime' / 'worker-mask'
        if not self.blank.exists():
            self.blank.write_bytes(b'')
            self.blank.chmod(0o600)
        require(self.blank.is_file() and not self.blank.is_symlink() and self.blank.stat().st_size == 0, 'UNSAFE_MASK')

    def argv(self, args):
        return ['docker', '--context', self.context, *args]

    def call(self, args, timeout=30, input=None):
        result = subprocess.run(self.argv(args), input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=self.env, timeout=timeout, check=False, text=True)
        require(result.returncode == 0, 'ENGINE_OPERATION_FAILED')
        require(len(result.stdout.encode()) <= 2 * 1024 * 1024, 'ENGINE_REPLY_LIMIT')
        return result.stdout

    def topology(self, project, git=False):
        root = self.storage / 'workspace' / project
        require(root.is_dir() and not root.is_symlink() and root.resolve() == root, 'UNSAFE_PROJECT')
        require((self.storage / 'workspace' / '.storage-id').read_text().strip() == self.storage_id, 'STORAGE_CHANGED')
        identity = root.stat()
        masks = []
        count = 0
        def visit(file, depth):
            nonlocal count
            count += 1
            require(count <= 200000 and depth <= 128, 'TOPOLOGY_LIMIT')
            st = file.lstat()
            if file.is_symlink():
                require(not PROTECTED.search(file.name) and file.resolve().is_relative_to(root), 'UNSAFE_LINK')
                return
            require(file.is_dir() or file.is_file() and st.st_nlink == 1, 'UNSAFE_FILE')
            if file != root and PROTECTED.search(file.name) and not (git and file.name == '.git'):
                masks.append({'path': str(file.relative_to(root)), 'directory': file.is_dir(), 'inode': f'{st.st_dev}:{st.st_ino}'})
                return
            if file.is_dir():
                for child in file.iterdir():
                    visit(child, depth + 1)
        visit(root, 0)
        for line in Path('/proc/self/mountinfo').read_text().splitlines():
            mount = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), line.split(' ')[4])
            require(not Path(mount).is_relative_to(root), 'NESTED_MOUNT')
        if git:
            require((root / '.git').is_dir() and not (root / '.git').is_symlink(), 'UNSAFE_GIT')
            require(not (root / '.git' / 'commondir').exists(), 'EXTERNAL_GIT')
        project_id = digest([self.storage_id, project, identity.st_dev, identity.st_ino])
        return root, masks, {'storageId': self.storage_id, 'projectId': project_id,
                             'imageId': self.images.get(project_id, self.image), 'layout': digest(masks)}

    def prepare(self, request):
        root, masks, identity = self.topology(request['project'], request['operation']['kind'] == 'git')
        key = request['contextId']
        existing = self.contexts.get(key)
        if existing:
            require(existing['identity'] == identity and existing['project'] == request['project'], 'CONTEXT_CHANGED')
            self.verify(existing)
            return identity
        require(len(self.contexts) < 32, 'CONTEXT_LIMIT')
        cache = self.storage / 'runtime' / 'dependencies' / identity['projectId']
        for directory in (cache.parent, cache, cache / 'home', cache / 'cache'):
            directory.mkdir(mode=0o700, exist_ok=True)
            require(directory.resolve() == directory and directory.stat().st_uid == self.uid, 'UNSAFE_CACHE')
        self.attestor.verify(identity['imageId'])
        name = 'abyssus-worker-' + str(uuid.uuid4())
        target = '/workspace/' + request['project']
        args = ['create', '--name', name, '--label', 'abyssus.storage=' + self.storage_id,
                '--label', 'abyssus.context=' + key, '--network', 'none', '--init', '--read-only',
                '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'KILL', '--security-opt', 'no-new-privileges',
                '--pids-limit', '256', '--memory', '2g', '--cpus', '2', '--user', '0:0',
                '--tmpfs', '/tmp:size=256m,mode=1777', '--tmpfs', '/run:size=16m,mode=755',
                '--mount', f'type=bind,src={root},dst={target}',
                '--mount', f'type=bind,src={cache / "home"},dst=/home/worker',
                '--mount', f'type=bind,src={cache / "cache"},dst=/cache',
                '--mount', f'type=bind,src={self.storage / "runtime" / "egress"},dst=/run/egress,readonly']
        for mask in masks:
            destination = target + '/' + mask['path']
            if mask['directory']:
                args += ['--tmpfs', destination + ':ro,noexec,nosuid,nodev,size=4k,mode=000']
            else:
                args += ['--mount', f'type=bind,src={self.blank},dst={destination},readonly']
        args += ['--entrypoint', '/usr/bin/python3', identity['imageId'], '-I', '/opt/abyssus-worker/worker-bridge.py']
        container = self.call(args).strip()
        require(re.fullmatch('[a-f0-9]{64}', container), 'INVALID_CONTAINER_ID')
        owned = {'container': container, 'identity': identity, 'project': request['project'], 'contextId': key}
        self.contexts[key] = owned  # Retain ownership if start/cleanup fails.
        self.call(['start', container])
        self.verify(owned)
        return identity

    def verify(self, owned):
        info = json.loads(self.call(['inspect', owned['container']]))[0]
        require(info['Id'] == owned['container'] and info['Image'] == owned['identity']['imageId'] and info['State']['Running'], 'WORKER_LOST')
        require(info['Config']['Labels'].get('abyssus.storage') == self.storage_id and info['Config']['Labels'].get('abyssus.context') == owned['contextId'], 'OWNERSHIP_CHANGED')

    def launch(self, record, proof_key):
        owned = self.contexts.get(record['contextId'])
        require(owned is not None, 'WORKER_LOST')
        self.verify(owned)
        args = ['exec', '-i', '--user', '0:0', owned['container'], '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
                '/usr/bin/python3', '-I', '/opt/abyssus-worker/worker-runner.py']
        process = subprocess.Popen(self.argv(args), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.env)
        request = {k: record[k] for k in ('claimId', 'project', 'operation', 'timeoutMs', 'outputLimit')}
        request.update(uid=self.uid, gid=self.gid, proofKey=proof_key)
        return process, (json.dumps(request, separators=(',', ':')) + '\n').encode()

    def close(self, context):
        owned = self.contexts.get(context)
        if not owned:
            return
        # Exact locally created ID only. Never discover/adopt from a name or PID.
        self.call(['rm', '--force', owned['container']])
        inspection = subprocess.run(self.argv(['inspect', owned['container']]), stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.env)
        require(inspection.returncode != 0, 'CLEANUP_UNCERTAIN')
        del self.contexts[context]
