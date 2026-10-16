"""Explicit source lifecycle client. No PID-file adoption or host-shell requests."""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parent))
from protocol import PROTOCOL, canonical, mac, decode, require, now


def request(storage, op):
    descriptor_file = Path(storage) / 'runtime/control/session.json'
    info = descriptor_file.lstat()
    require(not descriptor_file.is_symlink() and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0 and info.st_nlink == 1 and info.st_size < 2048, 'UNTRUSTED_SESSION')
    descriptor = json.loads(descriptor_file.read_text())
    nonce = secrets.token_hex(32)
    envelope = {'protocol': PROTOCOL, 'sessionId': descriptor['sessionId'], 'nonce': nonce, 'expiresAt': now() + 30000, 'op': op, 'body': {}}
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(400 if op == 'shutdown' else 5)
        connection.connect(str(Path(storage) / 'runtime/control/broker.sock'))
        connection.sendall((canonical({**envelope, 'mac': mac(envelope, descriptor['key'])}) + '\n').encode())
        raw = b''
        while not raw.endswith(b'\n'):
            block = connection.recv(4096)
            require(block and len(raw) + len(block) <= 262144, 'INVALID_REPLY')
            raw += block
        reply = decode(raw)
        signature = reply.pop('mac')
        import hmac
        require(hmac.compare_digest(signature, mac(reply, descriptor['key'])) and reply['nonce'] == nonce and reply['sessionId'] == descriptor['sessionId'] and reply['ok'] is True, 'BROKER_NOT_READY')
        return reply['result']


def main():
    require(len(sys.argv) == 6, 'INVALID_LAUNCH')
    action, storage, storage_id, source, context = sys.argv[1:]
    require(action in ('start', 'stop'), 'INVALID_LAUNCH')
    if action == 'stop':
        result = request(storage, 'shutdown')
        require(result == {'stopped': True}, 'CLEANUP_UNCERTAIN')
        # The signed reply confirms worker drain. Wait for the supervisor's
        # exclusive lifetime lease too, including listener/proxy/journal cleanup.
        # An immediate start must not reconnect to the closing session.
        import fcntl
        end = time.monotonic() + 20
        with (Path(storage) / 'runtime/broker.lock').open('a') as lease:
            while True:
                try:
                    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    require(time.monotonic() < end, 'BROKER_STOP_UNCERTAIN')
                    time.sleep(0.05)
        print('Owned worker broker stopped; retained records were preserved.')
        return
    try:
        result = request(storage, 'hello')
        require(result['storageId'] == storage_id, 'STORAGE_CHANGED')
        print('Authenticated owned worker broker is ready.')
        return
    except (FileNotFoundError, ConnectionRefusedError):
        pass
    env = {name: os.environ[name] for name in ('HOME', 'PATH') if name in os.environ}
    env['LANG'] = 'C.UTF-8'
    log = open(Path(storage) / 'runtime/broker.log', 'ab', buffering=0)
    child = subprocess.Popen(['/usr/bin/python3', '-I', str(Path(source) / 'containers/broker/server.py'), storage, storage_id, source, context],
                             env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True)
    log.close()
    end = time.monotonic() + 180
    while time.monotonic() < end:
        require(child.poll() is None, 'BROKER_START_FAILED')
        try:
            result = request(storage, 'hello')
            require(result['storageId'] == storage_id, 'STORAGE_CHANGED')
            print('Authenticated owned worker broker is ready.')
            return
        except (FileNotFoundError, ConnectionRefusedError):
            time.sleep(0.2)
    # Only the child launched by this invocation may be signalled, never a saved PID.
    child.terminate()
    raise RuntimeError('BROKER_START_TIMEOUT')

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Worker broker unavailable or cleanup uncertain. Inspect private runtime/broker.log; no fallback or replay.', file=sys.stderr)
        raise SystemExit(1)
