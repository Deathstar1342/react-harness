#!/usr/bin/python3 -I
"""dpkg-only guard. No process killing, profile access or helper activation."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

BASE = Path('/var/lib/abyssus-package')
PACKAGES = {'backend': 'abyssus-backend', 'desktop': 'react-harness', 'helper': 'abyssus-helper-staging'}
STATES = {'not-installed', 'config-files', 'half-installed', 'unpacked', 'half-configured', 'triggers-awaited', 'triggers-pending', 'installed'}

def package_state(package):
    result = subprocess.run(['/usr/bin/dpkg-query', '-W', '-f=${Status}', package],
                            stdin=subprocess.DEVNULL, capture_output=True, text=True,
                            timeout=5, cwd='/', env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
    if result.returncode == 1 and result.stdout == '' and result.stderr == f'dpkg-query: no packages found matching {package}\n':
        return 'not-installed'
    if result.returncode != 0 or result.stderr:
        raise RuntimeError('Package database query failed')
    fields = result.stdout.split(' ')
    if len(fields) != 3 or fields[0] not in {'unknown', 'install', 'hold', 'deinstall', 'purge'} or fields[1] != 'ok' or fields[2] not in STATES:
        raise RuntimeError('Package status is invalid or requires reinstallation')
    return fields[2]

def trusted_directory(p):
    if not p.exists(): p.mkdir(mode=0o755)
    s = p.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
        raise RuntimeError('Untrusted package state directory')

def trusted_file(p):
    s = p.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
        raise RuntimeError('Untrusted package payload or receipt')
    for parent in p.parents:
        s = parent.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
            raise RuntimeError('Untrusted package hierarchy')

def lock(p, mode):
    fd = os.open(p, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, mode)
    s = os.fstat(fd)
    if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
        raise RuntimeError('Untrusted package lock')
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return fd

def sync_directory(p):
    fd = os.open(p, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)

def verify_receipt(receipt, root, required):
    trusted_file(receipt)
    if receipt.stat().st_size > 16 * 1024 * 1024: raise RuntimeError('Oversized package receipt')
    hashes = json.loads(receipt.read_text())
    if not isinstance(hashes, dict) or len(hashes) > 50000 or not all(name in hashes for name in required):
        raise RuntimeError('Incomplete package receipt')
    for relative, digest in hashes.items():
        if not isinstance(relative, str) or '..' in Path(relative).parts or Path(relative).is_absolute() or not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest):
            raise RuntimeError('Invalid package receipt')
        payload = root / relative
        trusted_file(payload)
        if hashlib.sha256(payload.read_bytes()).hexdigest() != digest:
            raise RuntimeError('Installed package payload is incomplete or changed')

def main():
    if os.getuid() != 0: raise RuntimeError('Package manager authorization required')
    release = Path('/etc/os-release').read_text()
    if '\nID=ubuntu\n' not in '\n' + release or 'VERSION_ID="24.04"' not in release:
        raise RuntimeError('These packages require Ubuntu 24.04 x64')
    operation, actor = sys.argv[1], sys.argv[2]
    if actor not in PACKAGES or operation not in ('begin', 'finish', 'removed'):
        raise RuntimeError('Invalid package operation')
    trusted_directory(BASE)
    runtime_lock = lock(BASE / 'runtime.lock', 0o644)
    trusted_directory(Path('/var/lib/abyssus-helper'))
    admin_lock = lock(Path('/var/lib/abyssus-helper/admin.lock'), 0o600)
    if any(p.exists() or p.is_symlink() for p in map(Path, ['/etc/abyssus-helper/config.json', '/etc/systemd/system/abyssus-helper.service', '/run/abyssus-helper'])):
        raise RuntimeError('Disable helper authority through trusted setup before package maintenance')
    marker = BASE / 'maintenance'
    if operation == 'begin':
        trusted_directory(marker)
        fd = os.open(marker / actor, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o644)
        os.write(fd, b'Package maintenance incomplete. Configure or reinstall the matching packages.\n')
        os.fsync(fd)
        os.close(fd)
        sync_directory(marker)
        sync_directory(BASE)
        return
    states = {key: package_state(package) for key, package in PACKAGES.items()}
    for key, state in states.items():
        if key != actor and state not in ('installed', 'config-files', 'not-installed') and not (marker / key).exists():
            raise RuntimeError('Another package transaction is unfinished')
    if states['backend'] in ('config-files', 'not-installed'):
        raise RuntimeError('Required backend package is absent')
    verify_receipt(Path('/usr/share/abyssus/backend-manifest.json'), Path('/opt/abyssus'),
                   ('app/desktop/backend-entry.js', 'runtime/bin/node', 'runtime/manifest.json'))
    source = json.loads(Path('/opt/abyssus/app/release.json').read_text())['source']
    for key, receipt, root, executable, required in [
        ('desktop', Path('/opt/abysSUS/package-integrity.json'), Path('/opt/abysSUS'), Path('/opt/abysSUS/abysSUS'), ('resources/app/desktop/main.js', 'resources/app/desktop/package-lease.node')),
        ('helper', Path('/usr/share/abyssus/helper-manifest.json'), Path('/usr/lib/abyssus-helper'), Path('/usr/lib/abyssus-helper/launcher'), ('launcher', 'admin.py')),
    ]:
        removed = states[key] in ('config-files', 'not-installed') or (actor == key and operation == 'removed')
        if removed:
            if receipt.exists() or executable.exists(): raise RuntimeError('Removed package still has executable payload')
        else:
            verify_receipt(receipt, root, required)
            if key == 'desktop' and json.loads((root / 'resources/app/release.json').read_text())['source'] != source:
                raise RuntimeError('Mismatched desktop/backend source')
    if marker.exists():
        trusted_directory(marker)
        (marker / actor).unlink(missing_ok=True)
        sync_directory(marker)
        if not any(marker.iterdir()): marker.rmdir()
        sync_directory(BASE)
    assert runtime_lock >= 0 and admin_lock >= 0

if __name__ == '__main__':
    try: main()
    except Exception as error:
        if isinstance(error, RuntimeError): print(str(error), file=sys.stderr)
        print('abysSUS maintenance refused. Close app/backend, disable helper authority and inspect package state. No process was killed or user data removed.', file=sys.stderr)
        sys.exit(73)
