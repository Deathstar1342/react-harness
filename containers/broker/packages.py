"""Host-owned per-project container install target and immutable image publication."""
import json
import re
import threading
import uuid
from protocol import Denied, require, exact, digest, canonical, now, PROJECT, UUID, HEX

class Packages:
    def __init__(self, broker):
        self.broker, self.docker, self.journal = broker, broker.docker, broker.journal
        self.db = self.journal.db
        self.db.executescript('CREATE TABLE IF NOT EXISTS worker_heads(project TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS worker_installs(id TEXT PRIMARY KEY,data TEXT NOT NULL);')
        for project, raw in self.db.execute('SELECT project,data FROM worker_heads').fetchall():
            head = json.loads(raw)
            self.docker.images[project] = head['imageId']
        for (raw,) in self.db.execute('SELECT data FROM worker_installs').fetchall():
            row = json.loads(raw)
            if row['phase'] not in ('succeeded', 'failed', 'noop', 'uncertain'):
                row['phase'] = 'uncertain'
                if row.get('record'):
                    row['record'].update(state='uncertain', code='BROKER_RESTARTED')
                self.save(row)
        self.threads = {}

    def save(self, row):
        with self.db:
            self.db.execute('INSERT INTO worker_installs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', (row['id'], canonical(row)))
        return row

    def get(self, id, project):
        require(type(id) is str and UUID.fullmatch(id))
        found = self.db.execute('SELECT data FROM worker_installs WHERE id=?', (id,)).fetchone()
        require(found is not None, 'INSTALL_NOT_FOUND')
        row = json.loads(found[0])
        require(row['project'] == project, 'INSTALL_PROJECT_MISMATCH')
        return row

    def busy(self, project):
        return any(json.loads(raw)['project'] == project and json.loads(raw)['phase'] in ('executing', 'publishing', 'uncertain') for (raw,) in self.db.execute('SELECT data FROM worker_installs'))

    def target(self, project):
        _, _, identity = self.docker.topology(project)
        row = self.db.execute('SELECT data FROM worker_heads WHERE project=?', (identity['projectId'],)).fetchone()
        if row:
            head = json.loads(row[0])
        else:
            head = {'imageId': self.docker.image, 'generation': str(uuid.uuid4())}
            with self.db:
                self.db.execute('INSERT INTO worker_heads VALUES (?,?)', (identity['projectId'], canonical(head)))
        value = {'scope': 'project-container', 'storageId': self.docker.storage_id, 'projectId': identity['projectId'],
                 'baseImageId': head['imageId'], 'generation': head['generation'], 'distribution': 'debian',
                 'release': '12', 'architecture': 'amd64', 'manager': 'apt', 'adapterVersion': 1}
        return {**value, 'id': digest(value)}

    def receipt(self, row):
        require(row.get('record') is not None, 'INSTALL_PREPARATION_UNCERTAIN')
        if row['phase'] in ('executing','publishing'):
            return {**row['record'], 'state':'running', 'code':'RUNNING'}
        if row['phase'] == 'uncertain':
            result = {**row['record'], 'state':'uncertain', 'code':'INSTALL_PUBLICATION_UNCERTAIN'}
            result.pop('reconciliation', None)
            return result
        return row['record']

    def companion(self):
        args = ['run', '-d', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--pids-limit', '64', '--memory', '128m', '--cpus', '1', '--user', f'{self.docker.uid}:{self.docker.gid}',
                '--mount', f'type=bind,src={self.docker.storage / "runtime/egress"},dst=/run/egress,readonly',
                '--entrypoint', '/usr/bin/python3', self.docker.image, '-I', '/opt/abyssus-worker/worker-bridge.py']
        return self.docker.call(args).strip()

    def maintenance(self, image, companion=None):
        self.docker.attestor.verify(image)
        args = ['run', '-d', '--network', 'container:' + companion if companion else 'none', '--cap-drop', 'ALL',
                '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'KILL',
                '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '2g', '--cpus', '2', '--user', '0:0',
                '--tmpfs', '/tmp:size=256m,mode=1777', '--entrypoint', '/usr/bin/python3', image, '-I', '-c', 'import time;time.sleep(3600)']
        return self.docker.call(args).strip()

    def invoke(self, row, action, body):
        args = ['exec', '-i', '--user', '0:0', row['container'], '/usr/bin/env', '-i', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
                'APT_CONFIG=/usr/lib/abyssus-helper/apt.conf', 'DEBIAN_FRONTEND=noninteractive',
                'http_proxy=http://127.0.0.1:3128', 'https_proxy=http://127.0.0.1:3128',
                '/usr/bin/python3', '-I', '/opt/abyssus-packages/container-apt.py']
        value = self.docker.call(args, timeout=300, input=canonical({'target': row['target'], 'action': action, 'body': body}) + '\n')
        from protocol import decode
        return decode(value.encode())

    def cleanup(self, row):
        for field in ('container', 'companion'):
            if row.get(field):
                self.docker.call(['rm', '--force', row[field]])
                row[field] = None
                self.save(row)

    def dispatch(self, op, body):
        require(type(body) is dict and type(body.get('project')) is str and PROJECT.fullmatch(body['project']))
        project = body['project']
        if op == 'install_hello':
            require(set(body) in ({'project'}, {'project', 'originalTarget'}))
            if 'originalTarget' in body:
                target = body['originalTarget']
                require(any(json.loads(raw)['project'] == project and json.loads(raw)['target'] == target for (raw,) in self.db.execute('SELECT data FROM worker_installs')), 'ORIGINAL_TARGET_UNAVAILABLE')
            else:
                target = self.target(project)
            self.docker.attestor.verify(target['baseImageId'])
            return {'protocol': 'abyssus-helper-v1', 'target': target}
        if op == 'install_prepare':
            exact(body, ['project', 'request'])
            require(not self.busy(project), 'INSTALL_RECOVERY_REQUIRED')
            request = body['request']
            exact(request, ['requestId', 'targetId', 'manager', 'packages'])
            require(type(request['requestId']) is str and UUID.fullmatch(request['requestId']))
            require(request['manager'] == 'apt' and type(request['packages']) is list and 1 <= len(request['packages']) <= 16)
            names = set()
            for item in request['packages']:
                require(type(item) is dict and set(item) in ({'name'}, {'name','version'}))
                require(type(item['name']) is str and re.fullmatch('[a-z0-9][a-z0-9+.-]{1,63}', item['name']) and item['name'] not in names)
                names.add(item['name'])
                if 'version' in item:
                    require(type(item['version']) is str and re.fullmatch(r'[0-9][A-Za-z0-9.+:~\-]{0,127}', item['version']))
            target = self.target(project)
            require(request['targetId'] == target['id'], 'TARGET_CHANGED')
            require(self.db.execute('SELECT data FROM worker_installs WHERE id=?', (request['requestId'],)).fetchone() is None, 'DUPLICATE_INSTALL')
            require(self.db.execute('SELECT count(*) FROM worker_installs').fetchone()[0] < 10000, 'INSTALL_CAPACITY')
            row = {'id': request['requestId'], 'project': project, 'target': target, 'phase': 'preparing', 'record': None}
            self.save(row)
            try:
                row['companion'] = self.companion()
                self.save(row)
                row['container'] = self.maintenance(target['baseImageId'], row['companion'])
                self.save(row)
                row['record'] = self.invoke(row, 'prepare', request)
                row['phase'] = row['record']['state']
                self.save(row)
                if row['phase'] == 'noop':
                    self.cleanup(row)
                return self.receipt(row)
            except Exception:
                row['phase'] = 'uncertain'
                self.save(row)
                raise Denied('INSTALL_PREPARATION_UNCERTAIN') from None
        if op in ('install_authorize', 'install_execute'):
            exact(body, ['project', 'decision'])
            decision = body['decision']
            exact(decision, ['requestId', 'previewDigest', 'decisionNonce', 'expiresAt'])
            row = self.get(decision['requestId'], project)
            require(self.target(project) == row['target'], 'TARGET_CHANGED')
            require(type(decision['decisionNonce']) is str and HEX.fullmatch(decision['decisionNonce']))
            require(type(decision['expiresAt']) is int and now() < decision['expiresAt'] <= row['record']['expiresAt'], 'DECISION_EXPIRED')
            require(decision['previewDigest'] == row['record']['previewDigest'], 'PREVIEW_CHANGED')
            if op == 'install_authorize':
                require(row['phase'] == 'prepared', 'INSTALL_CONSUMED')
                row['record'] = self.invoke(row, 'authorize', decision)
                row['phase'] = 'authorized'
                self.save(row)
                return row['record']
            require(row['phase'] == 'authorized' and row['record']['decision'] == decision, 'INSTALL_CONSUMED')
            require(not self.busy(project), 'INSTALL_RECOVERY_REQUIRED')
            row['phase'] = 'executing'
            row['record'].update(state='running', code='RUNNING')
            self.save(row)  # Durable before apt effects; never execute this decision twice.
            thread = threading.Thread(target=self.execute, args=(row, decision), daemon=True)
            self.threads[row['id']] = thread
            thread.start()
            return {'requestId': row['id'], 'accepted': True}
        if op in ('install_status', 'install_reconcile'):
            exact(body, ['project', 'requestId'])
            row = self.get(body['requestId'], project)
            if op == 'install_reconcile' and row['phase'] == 'succeeded':
                self.docker.attestor.verify(row['resultImageId'])
                observed = {**row, 'container': self.maintenance(row['resultImageId'])}
                try:
                    reconciliation = self.invoke(observed, 'observe', row['record']['preview'])
                    require(reconciliation['healthy'] and reconciliation['matches'], 'INSTALL_OBSERVATION_MISMATCH')
                finally:
                    self.docker.call(['rm', '--force', observed['container']])
                row['record']['reconciliation'] = reconciliation
                self.save(row)
            return self.receipt(row)
        if op == 'reset':
            exact(body, ['project'])
            require(not self.busy(project), 'INSTALL_RECOVERY_REQUIRED')
            target = self.target(project)
            for context, owned in list(self.docker.contexts.items()):
                if owned['project'] == project:
                    self.docker.close(context)
            head = {'imageId': self.docker.image, 'generation': str(uuid.uuid4())}
            with self.db:
                self.db.execute('UPDATE worker_heads SET data=? WHERE project=?', (canonical(head), target['projectId']))
            self.docker.images[target['projectId']] = self.docker.image
            return {'project': project, 'reset': True, 'recipesRetained': True, 'reinstallRequiresNewApproval': True}
        raise Denied('UNKNOWN_INSTALL_OPERATION')

    def execute(self, row, decision):
        try:
            outcome = self.invoke(row, 'execute', decision)
            with self.broker.lock:
                row['record'] = outcome
                if outcome['state'] != 'succeeded':
                    row['phase'] = outcome['state']
                    self.save(row)
                    # Keep uncertain maintenance identity for evidence; no replay/re-adoption.
                    return
                row['phase'] = 'publishing'
                self.save(row)
            # Remove private one-use decisions from the resulting worker image.
            self.docker.call(['exec', row['container'], '/usr/bin/python3', '-I', '-c', "import shutil;shutil.rmtree('/var/lib/abyssus-container-install')"])
            image = self.docker.call(['commit', '--pause=true', row['container']], timeout=120).strip()
            require(re.fullmatch('sha256:[a-f0-9]{64}', image), 'IMAGE_COMMIT_UNCERTAIN')
            with self.broker.lock:
                row['resultImageId'] = image
                self.save(row)
            attestation = self.docker.attestor.verify(image)
            with self.broker.lock:
                require(self.target(row['project']) == row['target'], 'TARGET_CHANGED')
                for context, owned in list(self.docker.contexts.items()):
                    if owned['project'] == row['project']:
                        self.docker.close(context)
                self.cleanup(row)
                head = {'imageId': image, 'generation': str(uuid.uuid4())}
                row.update(phase='succeeded', attestation=attestation, resultGeneration=head['generation'], recipe=row['record']['preview']['packages'])
                with self.db:
                    self.db.execute('UPDATE worker_heads SET data=? WHERE project=?', (canonical(head), row['target']['projectId']))
                    self.db.execute('UPDATE worker_installs SET data=? WHERE id=?', (canonical(row), row['id']))
                self.docker.images[row['target']['projectId']] = image
        except Exception:
            with self.broker.lock:
                row['phase'] = 'uncertain'
                row['record'].update(state='uncertain', code='INSTALL_PUBLICATION_UNCERTAIN')
                row['record'].pop('reconciliation', None)
                self.save(row)
