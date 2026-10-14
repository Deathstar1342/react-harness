#!/usr/bin/python3 -I
"""dpkg-only package guard. No process killing, profile access, or helper setup."""
import fcntl
import os
from pathlib import Path
import sys
import json
import hashlib
import subprocess

base = Path('/var/lib/abyssus-package')
def trusted_directory(p):
    if not p.exists():
        p.mkdir(mode=0o755)
    s = p.lstat()
    if p.is_symlink() or not p.is_dir() or s.st_uid != 0 or s.st_mode & 0o022:
        raise RuntimeError('Untrusted package state directory')

def lock(p, mode):
    fd = os.open(p, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, mode)
    s = os.fstat(fd)
    if s.st_uid != 0 or s.st_mode & 0o022:
        raise RuntimeError('Untrusted package lock')
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return fd

try:
    if os.getuid() != 0: raise RuntimeError('Package manager authorization required')
    release = Path('/etc/os-release').read_text()
    if '\nID=ubuntu\n' not in '\n' + release or 'VERSION_ID="24.04"' not in release:
        raise RuntimeError('These packages require Ubuntu 24.04 x64')
    trusted_directory(base)
    runtime_lock = lock(base / 'runtime.lock', 0o644)
    trusted_directory(Path('/var/lib/abyssus-helper'))
    admin_lock = lock(Path('/var/lib/abyssus-helper/admin.lock'), 0o600)
    if Path('/etc/abyssus-helper/config.json').exists() or Path('/etc/systemd/system/abyssus-helper.service').exists() or Path('/run/abyssus-helper').exists():
        raise RuntimeError('Disable helper authority through trusted abysSUS setup before package maintenance')
    # Every launcher checks this marker under its shared lease. Interrupted dpkg
    # leaves it in place; only successful explicit configuration clears it.
    marker = base / 'maintenance'
    actor = sys.argv[2]
    if actor not in ('backend', 'desktop', 'helper'): raise RuntimeError('Invalid package actor')
    if sys.argv[1] == 'finish':
        # Configuration must verify the actual installed payload before allowing
        # starts after interruption. No blind marker deletion.
        hashes = json.loads(Path('/usr/share/abyssus/backend-manifest.json').read_text())
        for relative, digest in hashes.items():
            p = Path('/opt/abyssus') / relative
            if '..' in Path(relative).parts or Path(relative).is_absolute() or p.is_symlink() or hashlib.sha256(p.read_bytes()).hexdigest() != digest:
                raise RuntimeError('Installed backend payload is incomplete')
        source = json.loads(Path('/opt/abyssus/app/release.json').read_text())['source']
        desktop = Path('/opt/abysSUS')
        if desktop.exists():
            receipt = json.loads((desktop / 'package-integrity.json').read_text())
            for relative, digest in receipt.items():
                p = desktop / relative
                if '..' in Path(relative).parts or Path(relative).is_absolute() or p.is_symlink() or hashlib.sha256(p.read_bytes()).hexdigest() != digest:
                    raise RuntimeError('Desktop package is incomplete')
            if json.loads((desktop / 'resources/app/release.json').read_text())['source'] != source:
                raise RuntimeError('Mismatched desktop/backend source')
        helper_manifest = Path('/usr/share/abyssus/helper-manifest.json')
        if helper_manifest.exists():
            for relative, digest in json.loads(helper_manifest.read_text()).items():
                p = Path('/usr/lib/abyssus-helper') / relative
                if '..' in Path(relative).parts or Path(relative).is_absolute() or p.is_symlink() or hashlib.sha256(p.read_bytes()).hexdigest() != digest:
                    raise RuntimeError('Helper package is incomplete')
        packages = {'backend': 'abyssus-backend', 'desktop': 'react-harness', 'helper': 'abyssus-helper-staging'}
        for key, package in packages.items():
            if key == actor: continue  # dpkg is executing this package's configuration hook
            if (marker / key).exists(): continue  # its durable marker still blocks all starts
            query = subprocess.run(['/usr/bin/dpkg-query', '-W', '-f=${Status}', package], capture_output=True, text=True)
            # dpkg may retain a deinstall/hold selection after a refused removal;
            # current package/error state, not desired selection, decides safety.
            if query.returncode == 0 and query.stdout.split()[1:] not in (['ok', 'installed'], ['ok', 'config-files'], ['ok', 'not-installed']):
                raise RuntimeError('Another package transaction is unfinished')
        if marker.exists():
            trusted_directory(marker)
            (marker / actor).unlink(missing_ok=True)
            if not any(marker.iterdir()): marker.rmdir()
    else:
        trusted_directory(marker)
        fd = os.open(marker / actor, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o644)
        os.write(fd, b'Package maintenance incomplete. Configure or reinstall the matching packages.\n')
        os.fsync(fd)
        os.close(fd)
except Exception as error:
    if isinstance(error, RuntimeError): print(str(error), file=sys.stderr)
    print('abysSUS package maintenance refused: close the desktop/backend and disable helper authority first. Ubuntu 24.04 and trusted package state are required. No process was killed or user data removed.', file=sys.stderr)
    sys.exit(73)
