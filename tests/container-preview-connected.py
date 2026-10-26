"""Connected disposable Linux production controller -> wire -> broker -> worker -> Chrome.
No workstation runtime/provisioning. All control resources belong to this fixture.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
os.umask(0o077)
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'test-results/container/preview-connected';OUT.mkdir(parents=True,exist_ok=True)
source=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip();storage=Path(tempfile.mkdtemp(prefix='m35-connected-',dir=os.environ.get('RUNNER_TEMP','/tmp')));storage_id=str(uuid.uuid4());project=str(uuid.uuid4());checks=[];broker=None;controller=None

def run(args,*,timeout=120,env=None):
    result=subprocess.run(args,cwd=ROOT,capture_output=True,text=True,timeout=timeout,env=env)
    if result.returncode:raise AssertionError('Connected fixture subprocess failed: '+args[0]+' '+args[1])
    return result.stdout.strip()

def check(name,condition=True):
    assert condition,name
    checks.append(name);print('PASS:',name,flush=True)

try:
    for name in ('state','state/profile/state','config','workspace','runtime','runtime/control','runtime/egress','workspace/'+project):(storage/name).mkdir(mode=0o700,parents=True,exist_ok=True)
    for name in ('','state','config','workspace'):(storage/name/'.storage-id').write_text(storage_id+'\n')
    ui=Path(os.environ['M35_UI_OUTPUT']);root=storage/'workspace'/project
    for entry in ui.iterdir():
        if entry.is_dir():shutil.copytree(entry,root/entry.name)
        else:shutil.copy2(entry,root/entry.name)
    (root/'server.mjs').write_text('''import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
http.createServer((req,res)=>{if(req.url==='/environment'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(process.env));}
const raw=req.url.split('?')[0],file=raw==='/'?'index.html':raw.slice(1);if(file.includes('..')){res.writeHead(403);return res.end();}try{const body=fs.readFileSync(path.join(process.cwd(),file));res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(body)}catch{res.writeHead(404,{'Content-Type':'text/plain'});res.end('missing')}}).listen(3001,'127.0.0.1');
''')
    worker=run(['docker','image','inspect','abyssus-worker:m35','--format','{{.Id}}']);image=run(['docker','image','inspect','abyssus-controller:m28','--format','{{.Id}}']);check('exact immutable source-built worker/controller images resolved',bool(re.fullmatch('sha256:[a-f0-9]{64}',worker)) and bool(re.fullmatch('sha256:[a-f0-9]{64}',image)))
    log=(OUT/'broker.log').open('wb');broker=subprocess.Popen([sys.executable,'-I','-B',str(ROOT/'containers/broker/server.py'),str(storage),storage_id,str(ROOT),'default',worker],cwd=ROOT,stdout=log,stderr=log,env={key:os.environ[key] for key in ('HOME','PATH') if key in os.environ});log.close()
    deadline=time.monotonic()+180
    while not (storage/'runtime/control/session.json').exists():
        assert broker.poll() is None and time.monotonic()<deadline,'owned broker did not start'
        time.sleep(.1)
    check('actual authenticated private Unix broker session published')
    args=['docker','create','--init','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','2g','--cpus','2','--user',f'{os.getuid()}:{os.getgid()}','--tmpfs','/tmp:size=128m,mode=1777','-p','127.0.0.1:3000:3000','-e','HARNESS_EXECUTION_MODE=container','-e','HARNESS_STORAGE_ID='+storage_id,'-e','HARNESS_HOME=/abyssus','-e','M35_PROJECT='+project,'-e','M35_SOURCE='+source]
    for source_path,target,readonly in [(storage/'state','/abyssus',False),(storage/'config','/abyssus/profile/config',True),(storage/'workspace','/workspace',False),(storage/'runtime/control','/run/abyssus-broker',True),(ROOT/'tests/container-preview-fixture.mjs','/fixtures/main.mjs',True)]:args+=['--mount',f'type=bind,src={source_path},dst={target}'+(',readonly' if readonly else '')]
    args += ['--entrypoint','node',image,'--import','tsx','/fixtures/main.mjs'];controller=run(args);check('only exact owned disposable controller created',bool(re.fullmatch('[a-f0-9]{64}',controller)));run(['docker','start',controller])
    mapping=json.loads(run(['docker','inspect',controller]))[0];check('actual existing public port matches trusted source binding',mapping['HostConfig']['PortBindings']=={'3000/tcp':[{'HostIp':'127.0.0.1','HostPort':'3000'}]} and mapping['NetworkSettings']['Ports']['3000/tcp']==[{'HostIp':'127.0.0.1','HostPort':'3000'}])
    info_file=storage/'state/m35-fixture.json';deadline=time.monotonic()+120
    while not info_file.exists():
        assert time.monotonic()<deadline,'controller readiness deadline'
        time.sleep(.1)
    info=json.loads(info_file.read_text());old_instance=info['instance'];check('actual production ProcessJobs claim starts once',info['starts']==1)
    env=dict(os.environ,M35_CONNECTED_INFO=str(info_file),M35_RECEIPTS=str(OUT),M35_CONNECTED_STAGE='running')
    result=subprocess.run(['node','tests/container-preview-browser.mjs'],cwd=ROOT,env=env,capture_output=True,text=True,timeout=160);(OUT/'browser-running.log').write_text(result.stdout+result.stderr);check('connected real controller API/wire/broker/worker/browser rendered and drained',result.returncode==0)
    run(['docker','stop','--time','90',controller],timeout=100);run(['docker','start',controller]);deadline=time.monotonic()+120
    while time.monotonic()<deadline:
        try:
            info=json.loads(info_file.read_text())
            if info['instance']!=old_instance:break
        except (FileNotFoundError,json.JSONDecodeError):pass
        time.sleep(.1)
    check('same persistent controller fixture restarted without new process',info['instance']!=old_instance and info['starts']==0)
    env['M35_CONNECTED_STAGE']='recovered';result=subprocess.run(['node','tests/container-preview-browser.mjs'],cwd=ROOT,env=env,capture_output=True,text=True,timeout=90);(OUT/'browser-recovered.log').write_text(result.stdout+result.stderr);check('actual browser recovery sees retained uncertainty and no auto preview/command',result.returncode==0)
    (OUT/'connected.json').write_text(json.dumps({'source':source,'mode':'actual disposable Linux connected production controller/Store/Runtime/WorkspaceTools/Previews/WorkerClient authenticated Unix wire/real broker/actual owned worker/Chrome','controllerImage':image,'workerImage':worker,'checks':checks,'privateStorage':str(storage)},indent=2))
except BaseException as error:
    (OUT/'connected-failure.json').write_text(json.dumps({'source':source,'error':str(error),'checks':checks,'privateStorage':str(storage)},indent=2));raise
finally:
    if controller:
        subprocess.run(['docker','logs',controller],cwd=ROOT,stdout=(OUT/'controller.log').open('wb'),stderr=subprocess.STDOUT,timeout=20)
        subprocess.run(['docker','stop','--time','90',controller],cwd=ROOT,capture_output=True,timeout=100);subprocess.run(['docker','rm',controller],cwd=ROOT,capture_output=True,timeout=30)
    if broker:
        broker.terminate()
        try:broker.wait(timeout=60)
        except subprocess.TimeoutExpired:broker.kill();broker.wait(timeout=10)
