"""Linux entrypoint fault tests. Engine replies are synthetic; no Docker effects."""
import hashlib
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
ROOT=Path(__file__).resolve().parents[1]
base=Path(tempfile.mkdtemp(prefix='m32-boundaries-',dir=os.environ.get('RUNNER_TEMP','/tmp')))
source=base/'source';(source/'scripts').mkdir(parents=True)
for name in ('setup.sh','start.sh','scripts/source-desktop.sh'):shutil.copyfile(ROOT/name,source/name)
bin=base/'bin';bin.mkdir();sock=socket.socket(socket.AF_UNIX);socket_path=base/'engine.sock';sock.bind(str(socket_path))
engine='fixture|linux|x86_64|/var/lib/docker|[]'
cli=bin/'docker';cli.write_text('''#!/usr/bin/env bash
[[ -z "${STARK_API_KEY:-}" && -z "${OPENAI_API_KEY:-}" && -z "${NODE_OPTIONS:-}" ]] || exit 91
case "$*" in
'context show') printf 'default\n';;
'context inspect default --format {{.Endpoints.docker.Host}}') printf '%s\n' 'unix://SOCKET';;
'--context default info --format {{.ID}}|{{.OSType}}|{{.Architecture}}|{{.DockerRootDir}}|{{json .SecurityOptions}}') printf '%s\n' 'ENGINE';;
'--context default buildx inspect default --format {{.Driver}}|{{range .Nodes}}{{.Endpoint}}{{end}}') printf 'docker|default\n';;
'--context default image inspect '* ) printf '%s\n' "$5";;
*) exit 92;;
esac
'''.replace('SOCKET',str(socket_path)).replace('ENGINE',engine));cli.chmod(0o700)
env={**os.environ,'PATH':str(bin)+':'+os.environ['PATH'],'STARK_API_KEY':'SYNTHETIC-PRIVATE','OPENAI_API_KEY':'SYNTHETIC-PRIVATE','NODE_OPTIONS':'--hostile'}
def run(script,*args,ok=True,extra=None):
    result=subprocess.run(['bash',str(source/script),*args],env={**env,**(extra or {})},text=True,capture_output=True,timeout=20)
    assert 'SYNTHETIC-PRIVATE' not in result.stdout+result.stderr
    assert (result.returncode==0)==ok,result.stdout+result.stderr
    return result
run('setup.sh','--help');run('setup.sh','--check');assert not (source/'.container-desktop-source').exists()
run('setup.sh','--check',ok=False,extra={'DOCKER_HOST':'tcp://fixture.invalid:2375'})
run('start.sh','--check',ok=False)
selection=source/'.container-desktop-source';selection.mkdir(mode=0o700)
runtime=base/'runtime';runtime.mkdir(mode=0o700);(selection/'selection').write_text(str(runtime)+'\n')
run('setup.sh','--no-start',ok=False);assert not (runtime/'receipt').exists()
payload=runtime/'payload';payload.mkdir();(payload/'member').write_text('fixture')
manifest=hashlib.sha256(b'fixture').hexdigest()+'  member\n';(payload/'SHA256SUMS').write_text(manifest)
(runtime/'receipt').write_text('\n'.join(['linux','a'*40,'default','unix://'+str(socket_path),engine,hashlib.sha256(manifest.encode()).hexdigest()])+'\n')
for name in ('desktop-data','logs','crashes','temp'):(runtime/name).mkdir(mode=0o700)
for name in ('controller','worker'):(runtime/(name+'.iid')).write_text('sha256:'+'b'*64+'\n')
run('start.sh','--check');before=(runtime/'receipt').read_bytes();run('setup.sh','--no-start');assert (runtime/'receipt').read_bytes()==before
(payload/'extra').write_text('unexpected');run('start.sh','--check',ok=False);(payload/'extra').unlink()
(payload/'member').write_text('tampered');run('start.sh','--check',ok=False);(payload/'member').write_text('fixture')
(payload/'linked').symlink_to(payload/'member');run('start.sh','--check',ok=False);(payload/'linked').unlink()
runtime.rename(base/'unavailable');run('setup.sh','--no-start',ok=False);assert not runtime.exists()
print('PASS source wrapper read-only detection, secret stripping, retained interruption, rerun preservation, tamper/extra/link/missing refusal (synthetic engine)')
sock.close()
