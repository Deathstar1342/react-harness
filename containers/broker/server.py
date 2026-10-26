"""Linux source transport. Runtime/claims are reusable independently of Unix sockets."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import socket
import socketserver
import subprocess
import threading
import uuid
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from protocol import PROTOCOL, MAX_WIRE, Journal, Denied, require, exact, canonical, decode, mac, now, HEX, claim_identity
from docker_runtime import Docker

class Broker:
    def __init__(self, journal, docker):
        self.journal, self.docker = journal, docker
        self.lock = threading.RLock()
        self.jobs = {}
        from previews import Previews
        self.previews = Previews(self)
        self.closing = False
        self.shutdown_done = threading.Event()
        self.shutdown_error = False
        from packages import Packages
        self.packages = Packages(self)
        from transfer_service import Transfers
        self.transfers = Transfers(self)

    def dispatch(self, op, body):
        if op.startswith('preview_'):return self.previews.dispatch(op, body)
        with self.lock:
            require(not self.closing or op in ('observe','install_status','transfer_observe','transfer_cancel','transfer_release'), 'BROKER_CLOSING')
            if op.startswith('transfer_'):
                return self.transfers.dispatch(op, body)
            if op.startswith('install_') or op == 'reset':
                require(not self.transfers.busy(body.get('project')), 'TRANSFER_BUSY')
                return self.packages.dispatch(op, body)
            if op == 'desktop_hello':
                exact(body, [])
                return {'protocol':PROTOCOL,'revision':1,'sessionId':self.journal.session,'storageId':self.docker.storage_id,'imageId':self.docker.image,'engineId':self.docker.engine_id,'context':self.docker.context,'sourceDigest':self.docker.source_digest}
            if op == 'hello':
                exact(body, [])
                self.docker.call(['image', 'inspect', self.docker.image, '--format', '{{.Id}}'])
                return {'protocol': PROTOCOL, 'sessionId': self.journal.session, 'storageId': self.docker.storage_id,
                        'imageId': self.docker.image, 'available': True}
            if op == 'prepare':
                from protocol import command_request
                command_request(body)
                require(not self.transfers.busy(body['project']), 'TRANSFER_BUSY')
                require(not self.packages.busy(body['project']), 'INSTALL_RECOVERY_REQUIRED')
                for (raw,) in self.journal.db.execute('SELECT data FROM claims'):
                    retained = json.loads(raw)
                    if retained['project'] == body['project']:
                        require(retained['state'] != 'uncertain', 'PROJECT_UNCERTAIN')
                    if retained['contextId'] == body['contextId']:
                        require(retained['state'] not in ('prepared', 'accepted', 'running'), 'CONTEXT_BUSY')
                identity = self.docker.prepare(body)
                record = self.journal.prepare(body, identity)
                return {k: record[k] for k in ('claimId', 'binding', 'sessionId', 'identity', 'expiresAt')}
            if op == 'activate':
                record = self.journal.owned(body)
                require(record['state']=='prepared','CLAIM_CONSUMED')
                require(not self.transfers.busy(record['project']), 'TRANSFER_BUSY')
                require(record['contextId'] in self.docker.contexts,'WORKER_LOST')
                require(not self.packages.busy(record['project']), 'INSTALL_RECOVERY_REQUIRED')
                _, _, identity = self.docker.topology(record['project'], record['operation']['kind'] == 'git')
                self.docker.verify(self.docker.contexts[record['contextId']])
                record = self.journal.activate(body, identity)
                record.update(output='', outputBytes=0)
                self.journal.save(record)
                thread = threading.Thread(target=self.run, args=(record,), daemon=True)
                self.jobs[record['claimId']] = {'thread': thread, 'cancelled': False}
                thread.start()
                return {'claimId': record['claimId'], 'binding': record['binding'], 'state': 'accepted'}
            if op == 'observe':
                exact(body, ['claimId', 'binding', 'offset'])
                require(type(body['offset']) is int and 0 <= body['offset'] <= 1000000)
                record = self.journal.owned({k: body[k] for k in ('claimId', 'binding')})
                output = base64.b64decode(record.get('output', ''))
                require(body['offset'] <= len(output), 'INVALID_OFFSET')
                page = output[body['offset']:body['offset'] + 32768]
                return {'claimId': record['claimId'], 'binding': record['binding'], 'state': record['state'],
                        'offset': body['offset'], 'endOffset': body['offset'] + len(page), 'totalBytes': len(output),
                        'output': base64.b64encode(page).decode(), 'result': record.get('result')}
            if op == 'cancel':
                record = self.journal.owned(body)
                self.previews.invalidate(record['contextId'])
                if record['state'] == 'prepared':
                    self.docker.close(record['contextId'])
                    self.journal.cancel_prepared(body)
                    return {'claimId': record['claimId'], 'binding': record['binding'], 'cleanupConfirmed': True, 'beforeActivation': True}
                job = self.jobs.get(record['claimId'])
                if job:
                    job['cancelled'] = True
                try:
                    self.docker.close(record['contextId'])
                except Exception:
                    record.update(state='uncertain', code='CLEANUP_UNCERTAIN')
                    self.journal.save(record)
                    raise Denied('CLEANUP_UNCERTAIN') from None
                # This confirms namespace termination, never absence or rollback of effects.
                return {'claimId': record['claimId'], 'binding': record['binding'], 'cleanupConfirmed': True, 'beforeActivation': False}
            if op == 'close':
                exact(body, ['contextId'])
                require(type(body['contextId']) is str and HEX.fullmatch(body['contextId']))
                require(not any(j['thread'].is_alive() and self.journal.get(id)['contextId'] == body['contextId'] for id, j in self.jobs.items()), 'CONTEXT_BUSY')
                self.previews.invalidate(body['contextId'])
                self.docker.close(body['contextId'])
                return {'contextId': body['contextId'], 'cleanupConfirmed': True}
            raise Denied('UNKNOWN_OPERATION')

    def run(self, original):
        proof_key = secrets.token_hex(32)
        process = None
        final = None
        watchdog = None
        sequence = 0
        try:
            with self.lock:
                record = self.journal.get(original['claimId'])
                require(record['state'] == 'accepted', 'CLAIM_CONSUMED')
                if self.jobs[record['claimId']]['cancelled']:
                    raise Denied('CANCELLED_AFTER_ACCEPTANCE')
                record.update(state='running', code='RUNNING')
                self.journal.save(record)
                barrier=getattr(self.docker,'storage_barrier',None)
                if barrier:barrier()
                process, payload = self.docker.launch(record, proof_key)
            watchdog = threading.Timer(original['timeoutMs'] / 1000 + 45, process.kill)
            watchdog.daemon = True
            watchdog.start()
            def drain_error():
                count = 0
                for chunk in iter(lambda: process.stderr.read(8192), b''):
                    count += len(chunk)
                    if count > 262144:
                        process.kill()
                        return
            threading.Thread(target=drain_error, daemon=True).start()
            process.stdin.write(payload)
            process.stdin.close()
            while True:
                wire = process.stdout.readline(65537)
                if not wire:
                    break
                require(len(wire) <= 65536, 'RUNNER_PROTOCOL_FAILED')
                event = decode(wire)
                signature = event.pop('mac', None)
                require(type(signature) is str and hmac.compare_digest(signature, mac(event, proof_key)), 'RUNNER_PROOF_FAILED')
                require(event['claimId'] == original['claimId'] and event['sequence'] == sequence and final is None, 'RUNNER_SEQUENCE_FAILED')
                sequence += 1
                with self.lock:
                    current = self.journal.get(original['claimId'])
                    if event['event'] == 'output':
                        exact(event, ['claimId', 'sequence', 'event', 'data'])
                        chunk = base64.b64decode(event['data'], validate=True)
                        output = base64.b64decode(current.get('output', '')) + chunk
                        require(len(output) <= current['outputLimit'], 'RUNNER_OUTPUT_LIMIT')
                        current.update(output=base64.b64encode(output).decode(), outputBytes=len(output))
                        self.journal.save(current)
                    elif event['event'] == 'exit':
                        exact(event, ['claimId', 'sequence', 'event', 'exitCode', 'timedOut', 'truncated', 'shellReset', 'backgroundPids'])
                        require(type(event['exitCode']) is int and -255 <= event['exitCode'] <= 255, 'RUNNER_EXIT_FAILED')
                        require(all(type(event[k]) is bool for k in ('timedOut', 'truncated', 'shellReset')), 'RUNNER_EXIT_FAILED')
                        require(type(event['backgroundPids']) is list and len(event['backgroundPids']) <= 256 and all(type(v) is int and v > 0 for v in event['backgroundPids']), 'RUNNER_EXIT_FAILED')
                        final = {k: event[k] for k in ('exitCode', 'timedOut', 'truncated', 'shellReset', 'backgroundPids')}
                    else:
                        raise Denied('RUNNER_EVENT_FAILED')
            require(process.wait(timeout=10) == 0 and final is not None, 'RUNNER_EXIT_UNCERTAIN')
            with self.lock:
                current = self.journal.get(original['claimId'])
                require(current['state'] != 'uncertain', 'RETAIN_UNCERTAINTY')
                cancelled = self.jobs[original['claimId']]['cancelled']
                if final['timedOut'] or cancelled:
                    self.docker.close(original['contextId'])
                    final.update(shellReset=True, cancelled=cancelled)
                self.previews.invalidate(original['contextId'])
                current.update(state='finished', code='OBSERVED_EXIT', result=final)
                self.journal.save(current)
        except Exception:
            with self.lock:
                current = self.journal.get(original['claimId'])
                # Lost proof/reply/commit cannot become a fake no-effect result.
                self.previews.invalidate(original['contextId'])
                current.update(state='uncertain', code='EXECUTION_OR_CLEANUP_UNCERTAIN')
                current.pop('result', None)
                try:
                    self.docker.close(original['contextId'])
                except Exception:
                    pass
                self.journal.save(current)
        finally:
            if watchdog is not None:
                watchdog.cancel()
            if process is not None:
                if process.poll() is None:
                    process.kill()  # Owned Docker CLI only; container cleanup is separate above.
                for stream in (process.stdout, process.stderr):
                    stream.close()

    def shutdown(self):
        with self.lock:
            already = self.closing
            if not already:
                self.previews.invalidate()
                self.closing = True  # Admission barrier precedes snapshots and every await.
                install_threads = list(self.packages.threads.values())
                jobs = list(self.jobs.values())
        if already:
            require(self.shutdown_done.wait(380) and not self.shutdown_error, 'DRAIN_UNCERTAIN')
            return
        errors = []
        try:
            import time
            deadline = time.monotonic() + 330
            try:
                self.transfers.close()
            except Exception:
                errors.append('TRANSFER_DRAIN_UNCERTAIN')
            for thread in install_threads:
                thread.join(timeout=max(0, deadline-time.monotonic()))
                if thread.is_alive():
                    errors.append('INSTALL_DRAIN_UNCERTAIN')
            with self.lock:
                for job in jobs:
                    if job['thread'].is_alive():
                        job['cancelled'] = True
                for context in list(self.docker.contexts):
                    try:
                        self.docker.close(context)
                    except Exception:
                        errors.append('WORKER_CLEANUP_UNCERTAIN')
                for (raw,) in self.journal.db.execute('SELECT data FROM worker_installs').fetchall():
                    row = json.loads(raw)
                    if row['phase'] in ('prepared','authorized','preparing','failed','noop'):
                        try:
                            self.packages.cleanup(row)
                            row['phase'] = 'failed'
                            if row.get('record'):
                                row['record'].update(state='failed',code='BROKER_CLOSED')
                            self.packages.save(row)
                        except Exception:
                            errors.append('INSTALL_CLEANUP_UNCERTAIN')
                    elif row['phase'] in ('uncertain','executing','publishing'):
                        for field in ('container','companion'):
                            if row.get(field):
                                try:
                                    self.docker.resources.stop(row[field])
                                except Exception:
                                    errors.append('INSTALL_CLEANUP_UNCERTAIN')
            for job in jobs:
                job['thread'].join(timeout=15)
                if job['thread'].is_alive():
                    errors.append('WORKER_DRAIN_UNCERTAIN')
            require(not errors, 'DRAIN_UNCERTAIN')
        except Exception:
            self.shutdown_error = True
            raise
        finally:
            self.shutdown_done.set()


def serve(storage, storage_id, source, context, worker_image=None):
    import fcntl
    import signal
    os.umask(0o077)
    runtime = Path(storage) / 'runtime'
    lease = (runtime / 'broker.lock').open('a')
    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
    for name in ('control', 'egress'):
        directory = runtime / name
        directory.mkdir(mode=0o700, exist_ok=True)
        require(directory.resolve() == directory and directory.stat().st_uid == os.getuid() and directory.stat().st_mode & 0o066 == 0, 'UNSAFE_RUNTIME')
        if name == 'egress':
            directory.chmod(0o711)
    for file in (runtime / 'control' / 'broker.sock', runtime / 'egress' / 'proxy.sock'):
        if file.exists():
            require(file.is_socket(), 'UNSAFE_SOCKET')
            file.unlink()  # Exclusive broker lease; stale transport only, never data/containers.
    session = str(uuid.uuid4())
    key = secrets.token_hex(32)
    journal = Journal(str(runtime / 'worker-journal.sqlite'), session)
    docker = Docker(storage, storage_id, source, context, worker_image)
    from transfer_service import area
    area(storage)
    broker = Broker(journal, docker)
    broker.transfers.verify_journal()
    proxy_env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}
    proxy = subprocess.Popen([sys.executable, '-I', '-B', str(Path(source) / 'containers/broker/egress.py'), str(runtime / 'egress/proxy.sock')], env=proxy_env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            self.request.settimeout(35)
            envelope = None
            try:
                require(proxy.poll() is None, 'EGRESS_UNAVAILABLE')
                envelope = decode(self.rfile.readline(MAX_WIRE + 1))
                with broker.lock:
                    op, body = journal.authenticate(envelope, key)
                if op == 'shutdown':
                    exact(body, [])
                    broker.shutdown()
                    result = {'stopped': True}
                else:
                    result = broker.dispatch(op, body)
                unsigned = {'protocol': PROTOCOL, 'sessionId': session, 'nonce': envelope['nonce'], 'ok': True, 'result': result}
            except Exception as error:
                if envelope is None or type(envelope) is not dict or type(envelope.get('nonce')) is not str or not HEX.fullmatch(envelope['nonce']):
                    return
                code = str(error) if isinstance(error, Denied) and re.fullmatch('[A-Z_]{1,64}', str(error)) else 'BROKER_FAILURE'
                unsigned = {'protocol': PROTOCOL, 'sessionId': session, 'nonce': envelope['nonce'], 'ok': False, 'error': code}
            self.wfile.write((canonical({**unsigned, 'mac': mac(unsigned, key)}) + '\n').encode())
            self.wfile.flush()
            if unsigned.get('result') == {'stopped': True}:
                threading.Thread(target=self.server.shutdown, daemon=True).start()
    class Server(socketserver.ThreadingUnixStreamServer):
        daemon_threads = True
        def handle_error(self, request, address):
            pass
    import re
    socket_path = runtime / 'control/broker.sock'
    descriptor = runtime / 'control/session.json'
    with Server(str(socket_path), Handler) as server:
        data = {'protocol': PROTOCOL, 'sessionId': session, 'key': key, 'storageId': storage_id, 'socket': '/run/abyssus-broker/broker.sock'}
        temporary = descriptor.with_suffix('.pending')
        with temporary.open('w') as file:
            file.write(canonical(data))
            file.flush()
            os.fsync(file.fileno())
        temporary.replace(descriptor)
        def stop(*_):
            def drain():
                try:
                    broker.shutdown()
                finally:
                    server.shutdown()
            threading.Thread(target=drain, daemon=True).start()
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        try:
            server.serve_forever()
        finally:
            try:
                broker.shutdown()
            finally:
                proxy.terminate()
                proxy.wait(timeout=10)
                descriptor.unlink(missing_ok=True)
                journal.db.close()

if __name__ == '__main__':
    import sys
    require(len(sys.argv) in (5, 6), 'INVALID_LAUNCH')
    serve(*sys.argv[1:])
