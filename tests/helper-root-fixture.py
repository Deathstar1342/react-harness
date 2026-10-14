"""Fixed disposable-CI probes; staged root-owned by the CI workflow, never shipped."""
import fcntl
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import time

assert os.getuid() == 0 and Path('/root/abyssus-ci-authorized').is_file()
mode = sys.argv[1]
if mode == 'lock':
    with open('/var/lib/dpkg/lock-frontend', 'a') as lock:
        fcntl.lockf(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(os.getpid(), flush=True)
        time.sleep(60)
elif mode == 'interrupt':
    print('READY', flush=True)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        main = subprocess.check_output(['/usr/bin/systemctl', 'show', '-p', 'MainPID', '--value', 'abyssus-helper.service'], text=True).strip()
        if main == '0':
            time.sleep(.01)
            continue
        children = [int(main)]
        found = None
        for pid in children:
            try:
                children += [int(p) for p in Path(f'/proc/{pid}/task/{pid}/children').read_text().split()]
                if Path(f'/proc/{pid}/comm').read_text().strip() == 'dpkg':
                    found = pid
            except FileNotFoundError:
                pass
        if found:
            os.kill(found, signal.SIGSTOP)
            subprocess.run(['/usr/bin/systemctl', 'kill', '--signal=SIGKILL', '--kill-who=all', 'abyssus-helper.service'], check=True)
            print('INTERRUPTED_REAL_DPKG', flush=True)
            break
        time.sleep(.002)
    else:
        raise RuntimeError('real dpkg was not observed; interruption acceptance failed')
else:
    raise RuntimeError('unsupported fixture')
