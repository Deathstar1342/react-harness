"""Fixed disposable-CI probes; staged root-owned by the CI workflow, never shipped."""
import fcntl
from contextlib import closing
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import time
import uuid

assert os.getuid() == 0 and Path('/root/abyssus-ci-authorized').is_file()
mode = sys.argv[1]
if mode == 'lock':
    with open('/var/lib/dpkg/lock-frontend', 'a') as lock:
        fcntl.lockf(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(os.getpid(), flush=True)
        time.sleep(60)
elif mode == 'interrupt':
    request_id = str(uuid.UUID(sys.argv[2]))
    print('READY', flush=True)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        main = subprocess.check_output(['/usr/bin/systemctl', 'show', '-p', 'MainPID', '--value', 'abyssus-helper.service'], text=True).strip()
        if main == '0':
            time.sleep(.01)
            continue
        try:
            with closing(sqlite3.connect('file:/var/lib/abyssus-helper/audit.sqlite?mode=ro', uri=True, timeout=.1)) as db:
                row = db.execute('SELECT record FROM requests WHERE id=?', (request_id,)).fetchone()
        except sqlite3.OperationalError as error:
            # A concurrent durable helper save can briefly hold the audit lock.
            # Retry observation only, within the existing deadline; never count
            # a lock error as evidence of running/dpkg or successful interruption.
            if getattr(error, 'sqlite_errorcode', 0) & 255 not in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
                raise
            time.sleep(.002)
            continue
        if not row or json.loads(row[0])['state'] != 'running':
            time.sleep(.002)
            continue
        children = [int(main)]
        found = None
        for pid in children:
            try:
                children += [int(p) for p in Path(f'/proc/{pid}/task/{pid}/children').read_text().split()]
                argv = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
                if Path(f'/proc/{pid}/comm').read_text().strip() == 'dpkg' and (b'--unpack' in argv or b'--configure' in argv):
                    found = pid
            except FileNotFoundError:
                pass
        if found:
            os.kill(found, signal.SIGSTOP)
            subprocess.run(['/usr/bin/systemctl', 'kill', '--signal=SIGKILL', '--kill-who=all', 'abyssus-helper.service'], check=True)
            print('INTERRUPTED_REAL_DPKG_AFTER_DURABLE_RUNNING', flush=True)
            break
        time.sleep(.002)
    else:
        raise RuntimeError('real dpkg was not observed; interruption acceptance failed')
else:
    raise RuntimeError('unsupported fixture')
