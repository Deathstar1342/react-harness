"""Real disposable-engine M31 desktop supervisor matrix; no provider calls."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'test-results/container';OUT.mkdir(parents=True,exist_ok=True)
BASE=Path(tempfile.mkdtemp(prefix='m31-desktop-',dir=os.environ.get('RUNNER_TEMP','/tmp')))
STORAGE=BASE/'storage';STORAGE.mkdir(mode=0o700)
checks=[];child=None;ready=None;sequence=0
ENV={k:os.environ[k] for k in ('HOME','PATH') if k in os.environ};ENV['LANG']='C.UTF-8'
HTTP=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def docker(*args):return subprocess.check_output(['docker',*args],env=ENV,text=True,timeout=60).strip()
context=docker('context','show');engine=json.loads(docker('info','--format','{{json .}}'))
launch={'storage':str(STORAGE),'mode':'initialize','storageId':str(uuid.uuid4()),'context':context,'engineId':engine['ID'],'controllerImage':docker('image','inspect','abyssus-controller:m28','--format','{{.Id}}'),'workerImage':docker('image','inspect','abyssus-worker:m29','--format','{{.Id}}'),'key':secrets.token_hex(32),'token':secrets.token_hex(32),'launchId':str(uuid.uuid4())}
def check(name,value=True):assert value,name;checks.append(name);print('PASS M31:',name,flush=True)
def start():
    global child,ready
    child=subprocess.Popen([sys.executable,'-I','-B',str(ROOT/'containers/broker/support_entry.py')],cwd=BASE,env=ENV,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    child.stdin.write(json.dumps(launch)+'\n');child.stdin.flush()
    raw=child.stdout.readline(262145);assert len(raw)<=262144 and raw.endswith('\n'),'bounded ready frame'
    result=json.loads(raw);assert 'ready' in result,('supervisor startup',result)
    ready=result['ready'];return ready

def request(op):
    global sequence
    sequence+=1;child.stdin.write(json.dumps({'id':sequence,'request':op})+'\n');child.stdin.flush()
    raw=child.stdout.readline(262145);assert len(raw)<=262144 and raw.endswith('\n'),'bounded RPC frame'
    result=json.loads(raw);assert result.get('id')==sequence and 'error' not in result,('supervisor RPC',result)
    return result['result']

def api(route,body=None,expected=200,token=True):
    req=urllib.request.Request(ready['address']+'/api'+route,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json',**({'Authorization':'Bearer '+ready['token']} if token else {})})
    try:
        with HTTP.open(req,timeout=90) as response:status=response.status;value=json.load(response)
    except urllib.error.HTTPError as error:status=error.code;value=json.load(error)
    assert status==expected,(route,status,value)
    return value

def shutdown():
    instance=ready['identity']['instanceId'];nonce=secrets.token_hex(32);expires=int(time.time()*1000)+15000
    signed=['abyssus-backend-v1','shutdown',instance,nonce,expires]
    mac=hmac.new(ready['key'].encode(),json.dumps(signed,separators=(',',':')).encode(),hashlib.sha256).hexdigest()
    proof=api('/backend/shutdown',{'instanceId':instance,'nonce':nonce,'expiresAt':expires,'mac':mac})
    expected=hmac.new(ready['key'].encode(),json.dumps(['abyssus-backend-v1','proof','shutdown',nonce,expires,proof['identity']],separators=(',',':')).encode(),hashlib.sha256).hexdigest()
    assert proof['nonce']==nonce and hmac.compare_digest(expected,proof['mac'])
    end=time.monotonic()+60
    while not request({'op':'stopped'})['stopped']:assert time.monotonic()<end,'controller drain timeout';time.sleep(.1)
    assert request({'op':'drain'})=={'stopped':True}
    child.stdin.close();assert child.wait(timeout=20)==0

try:
    first=start();check('real native supervisor initializes and authenticates private controller',not first['reconnect'])
    api('/health',token=False,expected=401);api('/auth/pair',{'code':'0'*48},expected=403,token=False)
    check('controller requires bearer and disables browser pairing')
    project=api('/projects',{'name':'Desktop persistence','mode':'create'},201)
    source=BASE/'original';source.mkdir();(source/'hello.txt').write_text('native picker handoff fixture')
    selected=request({'op':'transfer-select','kind':'import','path':str(source),'project':None,'included':[],'history':False})
    authorized=request({'op':'transfer-authorize','handle':selected['handle']})
    imported=api('/project-transfers/import',{'name':'Native import','code':authorized['code']},201)
    check('native host handoff imports through real M30 copy and registration',imported['receipt']['phase']=='succeeded' and (source/'hello.txt').read_text()=='native picker handoff fixture')
    old_instance=ready['identity']['instanceId']
    # Kill only our exact disposable supervisor child. Controller/broker ownership persists.
    child.kill();child.wait(timeout=10);launch.update(mode='existing',key=secrets.token_hex(32),token=secrets.token_hex(32),launchId=str(uuid.uuid4()))
    reopened=start();check('explicit reconnect authenticates exact surviving controller without replay',reopened['reconnect'] and reopened['identity']['instanceId']==old_instance)
    check('projects survive supervisor crash',any(p['id']==project['id'] for p in api('/projects')))
    shutdown();check('signed shutdown requires clean durable receipt and exact worker drain')
    launch.update(key=secrets.token_hex(32),token=secrets.token_hex(32),launchId=str(uuid.uuid4()))
    restarted=start();check('deliberate recreation uses fresh controller identity',restarted['identity']['instanceId']!=old_instance)
    check('managed copies and registrations survive container recreation',any(p['id']==imported['project']['id'] for p in api('/projects')))
    shutdown();check('second clean stop retains private state and managed files',(STORAGE/'state/profile/state/state.sqlite').is_file())
except Exception as error:
    owner_file=STORAGE/'runtime/desktop-owner.json'
    if owner_file.exists():
        owner=json.loads(owner_file.read_text())
        if owner.get('id'):
            info=json.loads(docker('inspect',owner['id']))[0]
            if info['Config'].get('Labels',{}).get('abyssus.desktop')==owner['owner']:
                (OUT/'m31-desktop-ownership.json').write_text(json.dumps({'ownerPhase':owner.get('phase'),'mounts':[{k:m.get(k) for k in ('Type','Source','Destination','RW')} for m in info['Mounts']],'user':info['Config']['User'],'hostConfig':{key:info['HostConfig'].get(key) for key in ('Privileged','ReadonlyRootfs','NetworkMode','CapDrop','CapAdd','Devices','DeviceRequests','Binds','VolumesFrom','PidMode','IpcMode','UTSMode','Tmpfs','Init','PidsLimit','Memory','NanoCpus','SecurityOpt','PortBindings')}},indent=2))
    (OUT/'m31-desktop-failure.txt').write_text(type(error).__name__+': '+str(error))
    raise
finally:
    if child and child.poll() is None:
        # Failure cleanup is exact test-owned, never engine-wide discovery/prune.
        child.kill();child.wait(timeout=10)
    (OUT/'m31-desktop-checks.json').write_text(json.dumps({'source':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'checks':checks,'count':len(checks),'platform':'actual disposable Linux Docker','provider':'none','windows':'not tested'},indent=2))
