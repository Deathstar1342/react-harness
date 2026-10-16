"""Real disposable Linux Engine tests. Never run against established user storage.
Only the generated Compose project and its temporary fixture are controlled.
Receipts contain synthetic test data; reusable capabilities are never printed.
"""
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'test-results/container'
OUT.mkdir(parents=True, exist_ok=True)
os.umask(0o077)
storage = Path(tempfile.mkdtemp(prefix='abyssus-m28-', dir=os.environ.get('RUNNER_TEMP', '/tmp')))
storage_id = str(uuid.uuid4())
env = {k: os.environ[k] for k in ['HOME', 'PATH']}
env.update(ABYSSUS_STORAGE_ROOT=str(storage), ABYSSUS_STORAGE_ID=storage_id, ABYSSUS_UID=str(os.getuid()), ABYSSUS_GID=str(os.getgid()))
compose = ['docker', 'compose', '--env-file', '/dev/null', '-f', str(ROOT / 'containers/compose.yaml')]
checks = []
synthetic = 'M28_SYNTHETIC_PRIVATE_KEY_' + uuid.uuid4().hex
build_secret = 'M28_BUILD_CONTEXT_EXCLUSION_' + uuid.uuid4().hex

def run(args, *, ok=True, stdin=None, timeout=120):
    result = subprocess.run(args, cwd=ROOT, env=env, input=stdin, text=True, capture_output=True, timeout=timeout)
    if ok and result.returncode:
        # Commands must never include runtime credentials. Logs are redacted again at the receipt boundary.
        raise AssertionError(('Command failed: ' + ' '.join(args) + '\n' + result.stdout + result.stderr).replace(synthetic, '[synthetic key]').replace(build_secret, '[build sentinel]'))
    return result

def c(*args, **kwargs):
    return run(compose + list(args), **kwargs)

def check(name, condition=True):
    assert condition, name
    checks.append(name)
    print('PASS:', name, flush=True)

def exec_node(code, ok=True):
    return c('exec', '-T', 'controller', 'node', '--import', 'tsx', '--input-type=module', '-e', code, ok=ok)

cookies = http.cookiejar.CookieJar()
http = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(cookies))

def api(method, route, body=None, expected=200):
    request = urllib.request.Request('http://127.0.0.1:3000' + route, data=None if body is None else json.dumps(body).encode(), method=method, headers={'Content-Type': 'application/json'})
    try:
        with http.open(request, timeout=8) as response:
            status, data = response.status, json.load(response)
    except urllib.error.HTTPError as error:
        status, data = error.code, json.load(error)
    assert status == expected, (route, status, data)
    return data

def pair():
    cookies.clear()
    logs = c('logs', '--no-color', 'controller').stdout
    codes = re.findall(r'Browser pairing code \(single use, 5 minutes\): ([a-f0-9]{48})', logs)
    assert codes
    api('POST', '/api/auth/pair', {'code': codes[-1]})

def host_proof():
    request = c('exec', '-T', 'controller', 'node', '--import', 'tsx', 'containers/probe.ts', 'request').stdout
    proof = api('POST', '/api/backend/readiness', json.loads(request))
    c('exec', '-T', 'controller', 'node', '--import', 'tsx', 'containers/probe.ts', 'verify', stdin=request+'\n'+json.dumps(proof)+'\n')
    proof['identity']['profileId'] = str(uuid.uuid4())
    result = c('exec', '-T', 'controller', 'node', '--import', 'tsx', 'containers/probe.ts', 'verify', stdin=request+'\n'+json.dumps(proof)+'\n', ok=False)
    check('host endpoint HMAC/profile proof accepts exact identity and rejects substitution', result.returncode != 0)

try:
    check('Linux non-root fixture', os.name == 'posix' and os.getuid() != 0)
    run(['bash', 'setup.sh', '--container', '--check'])
    rejected = subprocess.run(['bash', 'setup.sh', '--container', '--check'], cwd=ROOT, env={**env, 'DOCKER_HOST': 'tcp://example.invalid:2375'}, capture_output=True)
    check('remote engine override rejected', rejected.returncode != 0)
    # Disposable checkout sentinel: prove it is excluded from every image layer.
    assert not (ROOT / '.env').exists()
    (ROOT / '.env').write_text('STARK_API_KEY=' + build_secret + '\n')
    build = c('build', 'controller', ok=False, timeout=1200)
    (OUT / 'build.log').write_text((build.stdout+build.stderr).replace(build_secret, '[build sentinel]'))
    (ROOT / '.env').unlink()
    if build.returncode:
        print((build.stdout+build.stderr)[-10000:].replace(build_secret, '[build sentinel]'), flush=True)
    check('pinned Linux controller image built', build.returncode == 0)
    inspect = json.loads(run(['docker', 'image', 'inspect', 'abyssus-controller:m28']).stdout)[0]
    (OUT / 'image.json').write_text(json.dumps({'id': inspect['Id'], 'architecture': inspect['Architecture'], 'os': inspect['Os'], 'base': 'node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203'}, indent=2))
    archive = OUT / 'image.tar'
    run(['docker', 'image', 'save', '--output', str(archive), 'abyssus-controller:m28'], timeout=180)
    layers = 0
    def no_secret(stream):
        prior = b''
        while chunk := stream.read(1024*1024):
            assert build_secret.encode() not in prior + chunk
            prior = chunk[-len(build_secret):]
    with tarfile.open(archive) as saved_image:
        for member in saved_image:
            if not member.isfile():
                continue
            stream = saved_image.extractfile(member)
            try:
                layer = tarfile.open(fileobj=stream, mode='r:*')
            except tarfile.ReadError:
                stream = saved_image.extractfile(member)
                no_secret(stream)
                continue
            layers += 1
            with layer:
                for entry in layer:
                    if entry.isfile():
                        no_secret(layer.extractfile(entry))
    assert layers > 0, 'No image filesystem layers inspected'
    archive.unlink()
    check('excluded checkout provider sentinel absent from saved image layers')
    init = ['docker', 'run', '--rm', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--network', 'none', '--user', f'{os.getuid()}:{os.getgid()}', '--tmpfs', '/tmp:size=128m,mode=1777', '--mount', f'type=bind,source={storage},target=/initialize', '--env', f'HARNESS_STORAGE_ID={storage_id}', 'abyssus-controller:m28', 'node', '--import', 'tsx', 'containers/initialize.ts']
    run(init)
    check('explicit empty-storage initialization and repeated initialization refusal', run(init, ok=False).returncode != 0)
    config = storage / 'config/.env'
    config.write_text('STARK_API_KEY=' + synthetic + '\n')
    config_hash = hashlib.sha256(config.read_bytes()).hexdigest()
    c('up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '90', 'controller')
    cid = c('ps', '-q', 'controller').stdout.strip()
    container = json.loads(run(['docker', 'inspect', cid]).stdout)[0]
    host = container['HostConfig']
    check('controller is non-root, read-only, capability-dropped and loopback-published', container['Config']['User'] == f'{os.getuid()}:{os.getgid()}' and host['ReadonlyRootfs'] and 'ALL' in host['CapDrop'] and host['PortBindings']['3000/tcp'][0]['HostIp'] == '127.0.0.1')
    check('only selected private/controller/workspace mounts, no Docker control', {m['Destination'] for m in container['Mounts']} == {'/abyssus', '/abyssus/profile/config', '/workspace'})
    check('provider key absent from container environment and logs', synthetic not in json.dumps(container['Config']) + c('logs', 'controller').stdout)
    api('GET', '/api/health', expected=401)
    api('POST', '/api/backend/readiness', {'instanceId': str(uuid.uuid4()), 'nonce': 'a'*64, 'expiresAt': int(time.time()*1000)+10000, 'mac': 'b'*64}, expected=403)
    check('API and lifecycle refuse unauthenticated access')
    host_proof()
    pair()
    settings = api('GET', '/api/settings')
    check('container mode public contract and provider privacy', settings['executionMode'] == 'container' and settings['executionAvailable'] is False and synthetic not in json.dumps(api('GET', '/api/provider-settings')))
    project = api('POST', '/api/projects', {'name': 'Foundation', 'mode': 'create'}, expected=201)
    chat = api('POST', f"/api/projects/{project['id']}/chats", {'title': 'Persistence receipt'}, expected=201)
    assert project['path'] == '/workspace/foundation'
    exec_node("import fs from 'node:fs'; fs.writeFileSync('/workspace/foundation/persistent.txt','retained project content');")
    exec_node("import {WorkspaceTools} from './server/tools/index.ts'; import {PackageHelperClient} from './server/package-helper.ts'; const t=new WorkspaceTools(); t.configureSandbox({home:'/abyssus',protectedPaths:[],projects:()=>[],executionMode:'container'}); for(const [name,args] of [['run_shell',{command:'touch /workspace/foundation/escaped'}],['execute_python',{code:'print(1)'}],['run_tests',{command:'node --test'}],['git_status',{}],['git_diff',{}]]) {const r=await t.execute({projectRoot:'/workspace/foundation',chatId:'synthetic',agentId:'synthetic'},{name,args});if(r.ok||!r.output.includes('M29'))throw new Error(name);} try {await PackageHelperClient.connect();throw new Error('helper allowed');}catch(e){if(e.message!=='CONTAINER_EXECUTION_UNAVAILABLE')throw e;} await t.dispose();")
    check('PTY/Python/tests/fixed Git/helper dispatch all explicitly unavailable', not (storage / 'workspace/foundation/escaped').exists())
    second = c('run', '--rm', '--no-deps', '-T', 'controller', ok=False)
    check('concurrent controller refuses SQLite ownership', second.returncode != 0)
    # Actual committed WAL pages survive SIGKILL without a clean Store.close/checkpoint.
    exec_node("import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync('/abyssus/profile/state/state.sqlite');db.exec('PRAGMA wal_autocheckpoint=0');db.prepare('INSERT OR REPLACE INTO state(key,data) VALUES (?,?)').run('m28:wal',JSON.stringify('committed-before-kill'));")
    check('WAL exists before crash', (storage / 'state/profile/state/state.sqlite-wal').stat().st_size > 0)
    run(['docker', 'kill', '--signal', 'KILL', cid])
    c('up', '-d', '--force-recreate', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '90', 'controller')
    pair()
    check('project/chat/config identity survives crash and container replacement', api('GET', '/api/projects') == [project] and api('GET', f"/api/chats/{chat['id']}")['chat']['id'] == chat['id'] and hashlib.sha256(config.read_bytes()).hexdigest() == config_hash)
    exec_node("import {DatabaseSync} from 'node:sqlite';import fs from 'node:fs';const db=new DatabaseSync('/abyssus/profile/state/state.sqlite',{readOnly:true});if(db.prepare('SELECT data FROM state WHERE key=?').get('m28:wal').data!==JSON.stringify('committed-before-kill')||fs.readFileSync('/workspace/foundation/persistent.txt','utf8')!=='retained project content')throw new Error('lost persistence');db.close();")
    check('committed WAL and managed files recovered after crash')
    c('stop', 'controller')
    c('up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '90', 'controller')
    host_proof()
    c('down')
    for relative in ['config', 'state', 'workspace', 'state/profile/profile.json', 'state/profile/state/state.sqlite', 'config/.env', 'workspace/.storage-id']:
        target = storage / relative
        saved = storage / ('saved-' + relative.replace('/', '-').replace('.', '_'))
        target.rename(saved)
        try:
            refused = c('run', '--rm', '--no-deps', '-T', 'controller', ok=False)
            check('missing ' + relative + ' refused without recreation', refused.returncode != 0 and not target.exists())
        finally:
            saved.rename(target)
    marker = storage / 'workspace/.storage-id'
    marker.write_text(str(uuid.uuid4())+'\n')
    refused = c('run', '--rm', '--no-deps', '-T', 'controller', ok=False)
    check('mismatched mount identity refused', refused.returncode != 0)
    marker.write_text(storage_id+'\n')
    # A valid native but unrelated database must also fail, not present an empty app.
    dbfile = storage / 'state/profile/state/state.sqlite'
    saved = dbfile.with_suffix('.saved')
    dbfile.rename(saved);dbfile.write_bytes(b'')
    try:
        refused = c('run', '--rm', '--no-deps', '-T', 'controller', ok=False)
        check('empty replacement database refused without initialization', refused.returncode != 0 and dbfile.stat().st_size == 0)
    finally:
        dbfile.unlink();saved.rename(dbfile)
    c('up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '90', 'controller')
    host_proof()
    check('restored original storage starts without reset')
except Exception as error:
    (OUT / 'failure.txt').write_text(str(error).replace(synthetic, '[synthetic key]').replace(build_secret, '[build sentinel]'))
    raise
finally:
    # Exact test-owned Compose project only. No volume deletion, prune or broad cleanup.
    c('down', ok=False)
    (OUT / 'checks.json').write_text(json.dumps({'checks': checks, 'count': len(checks), 'platform': 'disposable Linux Engine', 'windows': 'not tested', 'provider': 'synthetic private sentinel; no provider requests'}, indent=2))
