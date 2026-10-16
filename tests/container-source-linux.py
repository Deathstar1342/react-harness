"""Actual production Bash launcher + PTY acceptance on an owned disposable engine fixture."""
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import socket
import subprocess
import tempfile
import time

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'test-results/container'
KEY='M28_TERMINAL_PRIVATE_SYNTHETIC_KEY'
BASE=Path(tempfile.mkdtemp(prefix='m28-source-',dir=os.environ.get('RUNNER_TEMP','/tmp')))
STORAGE=BASE/'storage with spaces'
ENV={key:os.environ[key] for key in ['HOME','PATH']}
ENV['TERM']='xterm'
checks=[]
transcripts=[]
os.umask(0o077)

def check(name,condition=True):
    assert condition,name
    checks.append(name)
    print('PASS:',name,flush=True)

def terminal(answers):
    pid,fd=pty.fork()
    if pid==0:
        os.chdir(ROOT)
        os.execvpe('bash',['bash','setup.sh','--container','--no-start'],ENV)
    output=bytearray()
    offset=0
    try:
        for marker,answer in answers:
            deadline=time.monotonic()+180
            while marker.encode() not in output[offset:]:
                assert time.monotonic()<deadline,'Expected terminal prompt missing'
                if select.select([fd],[],[],0.2)[0]:
                    output.extend(os.read(fd,8192))
            offset=len(output)
            os.write(fd,answer.encode())
        deadline=time.monotonic()+180
        while time.monotonic()<deadline:
            if select.select([fd],[],[],0.2)[0]:
                try:
                    chunk=os.read(fd,8192)
                except OSError:
                    break
                if not chunk:
                    break
                output.extend(chunk)
        else:
            raise AssertionError('Terminal did not finish')
        _,status=os.waitpid(pid,0)
        pid=0
        check('synthetic provider key hidden in real terminal',KEY.encode() not in output)
        assert os.waitstatus_to_exitcode(status)==0,'Source setup failed'
    except BaseException:
        print(bytes(output).decode(errors='replace').replace(KEY,'[hidden synthetic key]')[-10000:],flush=True)
        raise
    finally:
        transcripts.append(bytes(output).decode(errors='replace').replace(KEY,'[hidden synthetic key]'))
        os.close(fd)
        if pid:
            try:os.kill(pid,signal.SIGKILL)
            except ProcessLookupError:pass
            os.waitpid(pid,0)

def launch(*args,ok=True):
    result=subprocess.run(['bash','start.sh','--container',*args],cwd=ROOT,env=ENV,capture_output=True,text=True,timeout=120)
    output=result.stdout+result.stderr
    assert KEY not in output
    transcripts.append(re.sub(r'Browser pairing code \(single use, 5 minutes\): [a-f0-9]{48}','Browser pairing code: [single-use redacted]',output))
    if ok:
        assert result.returncode==0,output
    return result

compose=['docker','compose','--env-file','/dev/null','-f',str(ROOT/'containers/compose.yaml')]
compose_env=None
try:
    assert not (ROOT/'.container-source').exists(),'Disposable checkout selection must be absent'
    prompts=[('Provider API base URL: ','https://fixture.invalid/v1\n'),('Provider API key (hidden;',KEY+'\n'),('architect exact model ID','\n'),('coder exact model ID','\n'),('critic exact model ID','\n')]
    terminal([('Absolute new/empty app storage directory:',str(STORAGE)+'\n'),('Type INITIALIZE:','INITIALIZE\n'),*prompts])
    selection=ROOT/'.container-source/selection'
    selected=selection.read_text().splitlines()
    check('explicit setup stores selected path with spaces and identity only',selected[0]==str(STORAGE) and len(selected)==2 and KEY not in selection.read_text() and selection.stat().st_mode&0o777==0o600)
    compose_env={**ENV,'ABYSSUS_STORAGE_ROOT':str(STORAGE),'ABYSSUS_STORAGE_ID':selected[1],'ABYSSUS_UID':str(os.getuid()),'ABYSSUS_GID':str(os.getgid())}
    config=STORAGE/'config/.env'
    check('private provider config saved outside image',KEY in config.read_text() and config.stat().st_mode&0o777==0o600)
    before_config=config.read_bytes()
    before_profile=(STORAGE/'state/profile/profile.json').read_bytes()
    before_selection=selection.read_bytes()
    terminal([(marker,'\n') for marker,_ in prompts])
    check('saved-selection setup rerun preserves profile, key and selection',before_config==config.read_bytes() and before_profile==(STORAGE/'state/profile/profile.json').read_bytes() and before_selection==selection.read_bytes())
    active=subprocess.run(compose+['ps','--status','running','-q'],cwd=ROOT,env=compose_env,capture_output=True,text=True,check=True)
    check('--no-start leaves no controller running',not active.stdout.strip())
    with socket.socket() as probe:
        probe.settimeout(1)
        check('previous component listener has stopped',probe.connect_ex(('127.0.0.1',3000))!=0)
    with socket.socket() as occupied:
        # Reuse only TIME_WAIT from the preceding real HTTP suite; never share a listener.
        occupied.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
        occupied.bind(('127.0.0.1',3000));occupied.listen()
        refused=launch(ok=False)
        check('occupied unrelated host port refuses launch without pairing or adoption',refused.returncode!=0 and 'Authenticated readiness passed' not in refused.stdout and 'Browser pairing code' not in refused.stdout and occupied.getsockname()==('127.0.0.1',3000))
    subprocess.run(compose+['down'],cwd=ROOT,env=compose_env,capture_output=True,check=True)
    started=launch()
    check('production launcher passes authenticated host readiness', 'Authenticated readiness passed' in started.stdout)
    controller=subprocess.run(compose+['ps','-q','controller'],cwd=ROOT,env=compose_env,capture_output=True,text=True,check=True).stdout.strip()
    runtime=subprocess.run(['docker','exec','-i',controller,'node','--import','tsx','--input-type=module'],input=(ROOT/'tests/container-runtime-probe.mjs').read_text(),capture_output=True,text=True,timeout=240)
    (OUT/'m29-runtime-sqlite.log').write_text(runtime.stdout+runtime.stderr)
    print(runtime.stdout,flush=True)
    check('actual Runtime disk-SQLite freshness and COMMIT matrix',runtime.returncode==0)
    launch('--stop')
    launch()
    check('production stop/start retains original native profile and key',before_profile==(STORAGE/'state/profile/profile.json').read_bytes() and before_config==config.read_bytes())
    launch('--stop')
    for name in ['config','state','workspace']:
        target=STORAGE/name;saved=STORAGE/(name+'-saved');target.rename(saved)
        try:
            refused=launch(ok=False)
            check('saved-selection missing '+name+' refuses without recreation',refused.returncode!=0 and not target.exists() and selection.read_bytes()==before_selection)
        finally:saved.rename(target)
    saved=BASE/'storage-away';STORAGE.rename(saved)
    try:
        refused=launch(ok=False)
        check('entire established storage disappearance refuses without recreation',refused.returncode!=0 and not STORAGE.exists() and selection.read_bytes()==before_selection)
    finally:saved.rename(STORAGE)
except Exception as error:
    (OUT/'source-failure.txt').write_text(str(error).replace(KEY,'[hidden synthetic key]'))
    raise
finally:
    if (STORAGE/'runtime/broker.log').exists():
        (OUT/'source-broker.log').write_text((STORAGE/'runtime/broker.log').read_text().replace(KEY,'[hidden synthetic key]'))
    if compose_env:
        subprocess.run(compose+['down'],cwd=ROOT,env=compose_env,capture_output=True)
    (OUT/'source-checks.json').write_text(json.dumps({'checks':checks,'count':len(checks),'platform':'actual disposable Linux Docker + PTY'},indent=2))
    (OUT/'source-terminal.log').write_text('\n'.join(transcripts))
