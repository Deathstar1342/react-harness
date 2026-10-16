"""Actual disposable M29 worker/PTY/package matrix. CI only; no existing storage."""
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'containers/broker'))
from protocol import Journal, Denied
from docker_runtime import Docker
from server import Broker

OUT = ROOT / 'test-results/container'
OUT.mkdir(parents=True, exist_ok=True)
os.umask(0o077)
checks = []
storage = Path(tempfile.mkdtemp(prefix='m29-worker-', dir=os.environ.get('RUNNER_TEMP', '/tmp')))
identity = str(uuid.uuid4())
proxy = None
broker = None
context = hashlib.sha256(b'shell-context').hexdigest()

def check(name, condition=True):
    assert condition, name
    checks.append(name)
    print('PASS:', name, flush=True)

def fresh(command, *, ctx=context, timeout=10000, operation=None, project='project'):
    request = {'claimId': str(uuid.uuid4()), 'project': project, 'contextId': ctx, 'operation': operation or {'kind': 'shell', 'command': command}, 'timeoutMs': timeout, 'outputLimit': 64000}
    prepared = broker.dispatch('prepare', request)
    return {'claimId': prepared['claimId'], 'binding': prepared['binding']}

def observe(token):
    end = time.monotonic() + 90
    offset = 0
    output = b''
    while time.monotonic() < end:
        state = broker.dispatch('observe', {**token, 'offset': offset})
        output += base64.b64decode(state['output'])
        offset = state['endOffset']
        if state['state'] in ('finished', 'uncertain') and offset == state['totalBytes']:
            return state, output.decode('utf-8', errors='replace')
        time.sleep(0.05)
    raise AssertionError('worker observation deadline')

def command(text, **kwargs):
    token = fresh(text, **kwargs)
    broker.dispatch('activate', token)
    state, output = observe(token)
    assert state['state'] == 'finished', (text[:50], state, output)
    return state['result'], output

try:
    build = subprocess.run(['docker','build','-f','containers/Worker.Dockerfile','-t','abyssus-worker:m29','.'], cwd=ROOT, capture_output=True, text=True, timeout=900)
    (OUT/'m29-worker-build.log').write_text(build.stdout+build.stderr)
    check('pinned real worker image built', build.returncode == 0)
    for name in ('workspace','runtime','config','state','runtime/control','runtime/egress','workspace/project','workspace/other'):
        (storage/name).mkdir(mode=0o700, parents=True, exist_ok=True)
    (storage/'.storage-id').write_text(identity+'\n')
    (storage/'workspace/.storage-id').write_text(identity+'\n')
    (storage/'runtime/egress').chmod(0o711)
    (storage/'config/provider-secret').write_text('SYNTHETIC_PROVIDER_SECRET')
    (storage/'workspace/other/private').write_text('OTHER_PROJECT_SECRET')
    (storage/'workspace/project/.env').write_text('PROJECT_SECRET_SENTINEL')
    proxy = subprocess.Popen(['/usr/bin/python3','-I',str(ROOT/'containers/broker/egress.py'),str(storage/'runtime/egress/proxy.sock')], env={'PATH':'/usr/bin:/bin'}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        if (storage/'runtime/egress/proxy.sock').exists():
            break
        time.sleep(0.05)
    docker = Docker(str(storage),identity,str(ROOT),'default')
    journal = Journal(str(storage/'runtime/claims.sqlite'),str(uuid.uuid4()))
    broker = Broker(journal,docker)
    check('pristine image independently exported and source-attested', bool(docker.attestor.base_digest))
    result, output = command('test -t 1 && mkdir sub && cd sub && export M29_VAR=retained; printf "PTY:%s" "$PWD"')
    check('real PTY and observed zero exit', result['exitCode'] == 0 and 'PTY:/workspace/project/sub' in output)
    result, output = command('printf "%s:%s" "$PWD" "$M29_VAR"')
    check('cwd and exported variables persist between owned commands', output == '/workspace/project/sub:retained')
    result, output = command("python3 - <<'PY'\nimport os\nprint(os.getuid())\nprint(open('/proc/self/status').read())\nPY")
    (OUT/'m29-child-principal.txt').write_text(output)
    check('child UID and all capability sets drop with no-new-privileges', result['exitCode'] == 0 and output.splitlines()[0] == str(os.getuid()) and all(field+'\t0000000000000000' in output for field in ('CapEff:','CapPrm:','CapInh:','CapAmb:')) and 'NoNewPrivs:\t1' in output)
    result, output = command('test ! -e /var/run/docker.sock && test ! -e /run/abyssus-broker/session.json && test ! -e /abyssus && test ! -e /workspace/other && test ! -s /workspace/project/.env && printf denied')
    check('worker lacks provider state broker control other projects and protected project secret', result['exitCode'] == 0 and output == 'denied')
    result, output = command("python3 - <<'PY'\nimport socket\nfor host,port in [('172.17.0.1',3000),('169.254.169.254',80),('10.0.0.1',53),('192.168.1.1',2375),('127.0.0.1',3000)]:\n s=socket.socket(); s.settimeout(.3)\n try: s.connect((host,port)); raise RuntimeError('private bypass')\n except OSError: pass\n finally: s.close()\ns=socket.socket(socket.AF_INET6);s.settimeout(.3)\ntry: s.connect(('::1',3000)); raise RuntimeError('IPv6 bypass')\nexcept OSError: pass\nprint('raw denied')\nPY")
    check('raw non-proxy host private metadata DNS-port and IPv6 bypass denied', result['exitCode'] == 0 and 'raw denied' in output)
    result, output = command("python3 - <<'PY'\nimport urllib.request\nfor url in ['http://127.0.0.1:3000','http://169.254.169.254/','http://172.17.0.1:2375']:\n req=urllib.request.build_opener(urllib.request.ProxyHandler({'http':'http://127.0.0.1:3128'}))\n try: req.open(url,timeout=3); raise RuntimeError('proxy bypass')\n except OSError: pass\nprint('proxy denied')\nPY")
    check('public proxy rejects private control targets', result['exitCode'] == 0 and 'proxy denied' in output)
    result, output = command("python3 - <<'PY'\nimport socket\ns=socket.socket();s.bind(('127.0.0.1',0));s.listen(); print('local tests allowed')\nPY")
    check('worker own loopback remains available for project tests', result['exitCode'] == 0)
    veto = fresh('touch /workspace/project/forbidden')
    cancelled = broker.dispatch('cancel',veto)
    check('prepared veto and exact cleanup prove no command dispatch', cancelled['beforeActivation'] and not (storage/'workspace/project/forbidden').exists())
    try:
        broker.dispatch('activate',veto)
        raise AssertionError('cancelled activation replayed')
    except Denied:
        check('consumed preparation cannot activate')
    result, output = command('python3 -c "import os; print(os.getcwd())"')
    check('Python executes in fresh owned project context after cleanup', result['exitCode'] == 0 and '/workspace/project' in output)
    started=time.monotonic()
    result, output = command('printf long-start; sleep 11; printf long-end',timeout=20000)
    check('actual PTY preserves terminal output and exit after eleven seconds',result['exitCode']==0 and output=='long-startlong-end' and time.monotonic()-started>=11)
    package=storage/'workspace/project/fixture-bin';package.mkdir()
    (package/'package.json').write_text(json.dumps({'name':'fixture-bin','version':'1.0.0','bin':{'fixture-bin':'cli.js'}}))
    (package/'cli.js').write_text('#!/usr/bin/env node\nconsole.log("INTERNAL_BIN_OK");\n');(package/'cli.js').chmod(0o755)
    (storage/'workspace/project/package.json').write_text(json.dumps({'name':'fixture-root','version':'1.0.0','private':True}))
    result, output=command('cd /workspace/project && npm install ./fixture-bin --offline --ignore-scripts --no-audit --no-fund',timeout=30000)
    check('offline npm creates normal internal dependency and bin links',result['exitCode']==0 and (storage/'workspace/project/node_modules/.bin/fixture-bin').is_symlink())
    result, output=command('./node_modules/.bin/fixture-bin')
    check('subsequent worker topology permits contained npm bin link chain',result['exitCode']==0 and 'INTERNAL_BIN_OK' in output)
    unsafe=storage/'workspace/project/cross-project-link';unsafe.symlink_to('../other')
    try:
        try:fresh('echo forbidden');raise AssertionError('cross-project link accepted')
        except Denied:check('cross-project link refuses next worker preparation')
    finally:unsafe.unlink()
    result, output = command('sleep 10', timeout=100)
    check('timeout has actual termination and reset evidence', result['timedOut'] and result['shellReset'])
    result, output = command('exec /bin/true')
    check('exec without valid cwd/env capture exposes state loss', result['shellReset'] and result['exitCode'] == 0)
    result, output = command('setsid /bin/sh -c "sleep 1; echo escaped > /workspace/project/late" >/dev/null 2>&1 &')
    time.sleep(1.2)
    check('setsid descendants are detected and cannot survive a terminal receipt', result['shellReset'] and result['backgroundPids'] and not (storage/'workspace/project/late').exists())
    broker.dispatch('close',{'contextId':context})
    subprocess.run(['git','init',str(storage/'workspace/project')],check=True,capture_output=True)
    result, output = command('',ctx=hashlib.sha256(b'git').hexdigest(),operation={'kind':'git','args':['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=all']})
    check('fixed Git executes in an owned worker', result['exitCode'] == 0)
    broker.dispatch('close',{'contextId':hashlib.sha256(b'git').hexdigest()})
    hello = broker.dispatch('install_hello',{'project':'project'})
    request = {'requestId':str(uuid.uuid4()),'targetId':hello['target']['id'],'manager':'apt','packages':[{'name':'hello'}]}
    preview = broker.dispatch('install_prepare',{'project':'project','request':request})
    check('real apt preview has exact trusted package closure and container identity', preview['state'] == 'prepared' and preview['preview']['target']['scope'] == 'project-container' and preview['preview']['packages'])
    row = broker.packages.get(request['requestId'],'project')
    inspected = json.loads(docker.call(['inspect',row['container']]))[0]
    check('root maintenance has no filesystem mounts controller state or daemon access', not any(m['Type'] in ('bind','volume') for m in inspected['Mounts']) and inspected['HostConfig']['NetworkMode'].startswith('container:') and not inspected['HostConfig']['Privileged'])
    decision = {'requestId':request['requestId'],'previewDigest':preview['previewDigest'],'decisionNonce':secrets.token_hex(32),'expiresAt':preview['expiresAt']}
    broker.dispatch('install_authorize',{'project':'project','decision':decision})
    broker.dispatch('install_execute',{'project':'project','decision':decision})
    deadline = time.monotonic()+360
    while time.monotonic()<deadline:
        receipt=broker.dispatch('install_status',{'project':'project','requestId':request['requestId']})
        if receipt['state'] in ('succeeded','failed','uncertain'):
            break
        time.sleep(.2)
    row=broker.packages.get(request['requestId'],'project')
    diagnostic={'state':receipt['state'],'code':receipt.get('code'),'phase':row['phase'],'failureCode':row.get('failureCode'),'trustedDifferences':getattr(docker.attestor,'last_difference',[])}
    (OUT/'m29-install-diagnostic.json').write_text(json.dumps(diagnostic,indent=2))
    print('Install observation:',json.dumps(diagnostic),flush=True)
    check('real apt transaction commits only an attested image after exact cleanup', receipt['state']=='succeeded')
    result, output = command('hello')
    check('approved package executes from the new worker generation', result['exitCode']==0 and 'Hello, world!' in output)
    old_target=hello['target']
    new_target=broker.dispatch('install_hello',{'project':'project'})['target']
    check('image switch changes exact target generation', new_target['id']!=old_target['id'])
    original=broker.dispatch('install_hello',{'project':'project','originalTarget':old_target})
    recovered=broker.dispatch('install_reconcile',{'project':'project','requestId':request['requestId']})
    check('recovery observes the original receipt after the latest generation advances', original['target']==old_target and recovered['reconciliation']['matches'])
    broker.dispatch('close',{'contextId':context})
    reset=broker.dispatch('reset',{'project':'project'})
    check('explicit rebuild retains recipes and requires a new approval without replay', reset['recipesRetained'] and reset['reinstallRequiresNewApproval'])
    result, output=command('command -v hello || true')
    check('base reset never silently reinstalls a reviewed recipe', output=='')
    # A package layer may not replace trusted execution code, even if its own
    # tools would claim success. Export/hash happens on the trusted host.
    poisoned=docker.resources.create(['--network','none','--entrypoint','/usr/bin/python3',docker.image,'-I','-c','import time;time.sleep(120)'],docker.image,'maintenance')
    docker.call(['start',poisoned])
    try:
        docker.call(['exec',poisoned,'/usr/bin/python3','-I','-B','-c',"from pathlib import Path;Path('/opt/abyssus-worker/worker-runner.py').write_text('replaced by test package')"])
        bad_image=docker.call(['commit',poisoned],timeout=120).strip()
        try:
            docker.attestor.verify(bad_image)
            raise AssertionError('changed trusted runner accepted')
        except Denied as error:
            check('independent image attestation rejects modified trusted runner',str(error)=='TRUSTED_EXECUTION_BASE_CHANGED')
    finally:
        docker.resources.remove(poisoned)
    # A second real apt transaction with a publication-cleanup fault must retain
    # uncertainty and its old head, even after successful apt and image export.
    hello2=broker.dispatch('install_hello',{'project':'other'})
    request2={'requestId':str(uuid.uuid4()),'targetId':hello2['target']['id'],'manager':'apt','packages':[{'name':'hello'}]}
    preview2=broker.dispatch('install_prepare',{'project':'other','request':request2})
    decision2={'requestId':request2['requestId'],'previewDigest':preview2['previewDigest'],'decisionNonce':secrets.token_hex(32),'expiresAt':preview2['expiresAt']}
    broker.dispatch('install_authorize',{'project':'other','decision':decision2})
    original_cleanup=broker.packages.cleanup
    def lost_cleanup(row):
        if row['id']==request2['requestId'] and row['phase']=='publishing':
            raise Denied('INJECTED_PUBLICATION_CLEANUP_LOSS')
        return original_cleanup(row)
    broker.packages.cleanup=lost_cleanup
    broker.dispatch('install_execute',{'project':'other','decision':decision2})
    deadline=time.monotonic()+360
    while time.monotonic()<deadline:
        receipt2=broker.dispatch('install_status',{'project':'other','requestId':request2['requestId']})
        if receipt2['state'] in ('succeeded','failed','uncertain'):break
        time.sleep(.2)
    broker.packages.cleanup=original_cleanup
    retained=broker.packages.get(request2['requestId'],'other')
    check('publication cleanup failure retains uncertainty and original image generation',receipt2['state']=='uncertain' and retained.get('failureCode')=='INJECTED_PUBLICATION_CLEANUP_LOSS' and broker.packages.target('other')==hello2['target'] and retained.get('resultImageId'))
    broker.shutdown();journal.db.close();docker.resources.db.close()
    docker=Docker(str(storage),identity,str(ROOT),'default')
    journal=Journal(str(storage/'runtime/claims.sqlite'),str(uuid.uuid4()))
    broker=Broker(journal,docker)
    recovered2=broker.dispatch('install_status',{'project':'other','requestId':request2['requestId']})
    check('broker restart retains uncertain package receipt without transaction replay',recovered2['state']=='uncertain' and broker.packages.target('other')==hello2['target'])
    try:
        broker.dispatch('install_execute',{'project':'other','decision':decision2})
        raise AssertionError('uncertain transaction replayed')
    except Denied:
        check('uncertain install decision cannot be reused after restart')
    check('original host storage and other project remain untouched', (storage/'config/provider-secret').read_text()=='SYNTHETIC_PROVIDER_SECRET' and (storage/'workspace/other/private').read_text()=='OTHER_PROJECT_SECRET')
except Exception as error:
    (OUT/'m29-worker-failure.txt').write_text(repr(error))
    raise
finally:
    cleanup_error=None
    if broker:
        try:
            broker.shutdown()
        except Exception as error:
            (OUT/'m29-worker-cleanup-failure.txt').write_text(type(error).__name__)
            cleanup_error=error
    if proxy:
        proxy.terminate()
        proxy.wait(timeout=10)
    (OUT/'m29-worker.json').write_text(json.dumps({'source':os.environ.get('GITHUB_SHA'),'checks':checks,'count':len(checks),'kind':'actual-disposable-linux-containers'},indent=2))

    if cleanup_error is not None:
        raise RuntimeError('Owned worker cleanup was not confirmed') from cleanup_error
