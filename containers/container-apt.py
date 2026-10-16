"""Fixed container-only boundary around the existing deterministic apt adapter."""
import contextlib
import json
import os
from pathlib import Path
import sys
sys.path.insert(0, '/opt/abyssus-packages')
from apt_adapter import AptAdapter
from core import Audit, Engine, canonical, require

class ContainerAdapter(AptAdapter):
    def __init__(self, target):
        self.container_target = target
        super().__init__(target['storageId'])
    def target(self):
        return self.container_target

request = json.loads(sys.stdin.buffer.readline(262145))
require(set(request) == {'target', 'action', 'body'})
require(request['target'].get('scope') == 'project-container')
directory = Path('/var/lib/abyssus-container-install')
directory.mkdir(mode=0o700, exist_ok=True)
identity = directory / 'target.json'
if identity.exists():
    require(json.loads(identity.read_text()) == request['target'], 'WRONG_TARGET')
else:
    identity.write_text(canonical(request['target']))
    identity.chmod(0o600)
# Package subprocess output is not a control response and never reaches the broker wire.
reply = os.dup(1)
log = os.open('/dev/null', os.O_WRONLY)
os.dup2(log, 1)
os.dup2(log, 2)
os.close(log)
try:
    adapter = ContainerAdapter(request['target'])
    if request['action'] == 'observe':
        with adapter.lock():
            result = adapter.reconcile(request['body'])
    else:
        audit = Audit(str(directory / 'requests.sqlite'), recover=False)
        result = Engine(audit, adapter).dispatch(request['action'], request['body'])
        audit.db.close()
    os.write(reply, (canonical(result) + '\n').encode())
finally:
    os.close(reply)
