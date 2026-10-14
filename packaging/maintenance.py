#!/usr/bin/python3 -I
"""dpkg-only package guard. No process killing, profile access, or helper setup."""
import fcntl
import os
from pathlib import Path
import sys
import json
import hashlib

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
    if sys.argv[1] == 'finish':
        # Configuration must verify the actual installed payload before allowing
        # starts after interruption. No blind marker deletion.
        hashes = json.loads(Path('/usr/share/abyssus/backend-manifest.json').read_text())
        for relative, digest in hashes.items():
            p = Path('/opt/abyssus') / relative
            if '..' in Path(relative).parts or Path(relative).is_absolute() or p.is_symlink() or hashlib.sha256(p.read_bytes()).hexdigest() != digest:
                raise RuntimeError('Installed backend payload is incomplete')
        if marker.is_symlink(): raise RuntimeError('Untrusted maintenance marker')
        marker.unlink(missing_ok=True)
    else:
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o644)
        os.write(fd, b'Package maintenance incomplete. Configure or reinstall the matching packages.\n')
        os.fsync(fd)
        os.close(fd)
except Exception:
    print('abysSUS package maintenance refused: close the desktop/backend and disable helper authority first. Ubuntu 24.04 and trusted package state are required. No process was killed or user data removed.', file=sys.stderr)
    sys.exit(73)
