"""Actual disposable Linux owned-worker HTTP preview. CI only, no workstation setup.

Real pinned image/attestation, broker claims, network=none worker/server, bounded
GET helper/pages, exact cleanup/restart. Browser/native evidence is separate.
"""
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
os.umask(0o077)
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'containers/broker'))
from protocol import Journal,Denied
from docker_runtime import Docker
from server import Broker
OUT=ROOT/'test-results/container';OUT.mkdir(parents=True,exist_ok=True)
source=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
storage=Path(tempfile.mkdtemp(prefix='m35-worker-',dir=os.environ.get('RUNNER_TEMP','/tmp')))
storage_id=str(uuid.uuid4());project=str(uuid.uuid4());other=str(uuid.uuid4());checks=[];broker=None;proxy=None;unrelated=None

def check(name,condition=True):
    assert condition,name
    checks.append(name);print('PASS:',name,flush=True)

def read(token,target='/'):
    opened=broker.dispatch('preview_open',{**token,'path':target});offset=0;data=b''
    try:
        while offset<opened['totalBytes']:
            page=broker.dispatch('preview_read',{**token,'handle':opened['handle'],'offset':offset});block=base64.b64decode(page['data']);assert len(block)<=32768;data+=block;offset=page['nextOffset']
        return opened,data
    finally:broker.dispatch('preview_close',{**token,'handle':opened['handle']})

def start(*,child=False):
    request={'claimId':str(uuid.uuid4()),'project':project,'contextId':secrets.token_hex(32),'operation':{'kind':'shell','command':('M35_CHILD=1 ' if child else '')+'node server.mjs','previewPort':3001},'timeoutMs':60000,'outputLimit':64000}
    prepared=broker.dispatch('prepare',request);token={key:prepared[key] for key in ('claimId','binding')};broker.dispatch('activate',token)
    end=time.monotonic()+25
    while time.monotonic()<end:
        try:
            value,data=read(token)
            if value['status']==200:return request,token,data
        except Exception:time.sleep(.1)
    raise AssertionError('owned dev server did not become ready')

def terminal(token):
    end=time.monotonic()+30
    while time.monotonic()<end:
        value=broker.dispatch('observe',{**token,'offset':0})
        if value['state'] in ('finished','uncertain'):return value
        time.sleep(.1)
    raise AssertionError('owned process outcome deadline')

try:
    build=subprocess.run(['docker','build','-f','containers/Worker.Dockerfile','-t','abyssus-worker:m35','.'],cwd=ROOT,capture_output=True,text=True,timeout=900)
    (OUT/'m35-preview-image.log').write_text(build.stdout+build.stderr);check('exact-source pinned preview worker image built',build.returncode==0)
    for name in ('workspace','runtime','state','config','runtime/control','runtime/egress','workspace/'+project,'workspace/'+other):(storage/name).mkdir(mode=0o700,parents=True,exist_ok=True)
    (storage/'.storage-id').write_text(storage_id+'\n');(storage/'workspace/.storage-id').write_text(storage_id+'\n');(storage/'runtime/egress').chmod(0o711)
    root=storage/'workspace'/project
    (root/'server.mjs').write_text('''import http from 'node:http';import fs from 'node:fs';import {spawn} from 'node:child_process';
let privateHits=0;const html='<!doctype html><title>Actual owned worker preview</title><h1>Owned worker server</h1><button id="counter">Count 0</button><script src="/app.js"></script>';
if(process.env.M35_CHILD==='1'){const child=spawn(process.execPath,['-e',"setInterval(()=>require('fs').appendFileSync('late.txt','x'),25)"],{stdio:'ignore'});child.unref();}
http.createServer((req,res)=>{if(req.url==='/private'){privateHits++;res.setHeader('Content-Type','text/plain');return res.end('private');}
if(req.url==='/redirect'){res.writeHead(302,{Location:'http://127.0.0.1:3001/private','Content-Type':'text/html','Content-Length':'0'});return res.end();}
if(req.url==='/stats'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({privateHits,headers:req.headers}));}
if(req.url==='/big'){res.setHeader('Content-Type','text/javascript');return res.end('a'.repeat(200000));}
if(req.url==='/oversized'){res.setHeader('Content-Type','text/javascript');res.setHeader('Content-Length','4194305');return res.end();}
if(req.url==='/slow'){res.setHeader('Content-Type','text/html');setTimeout(()=>res.end('too late'),20000);return;}
if(req.url==='/exit'){res.setHeader('Content-Type','text/plain');res.end('closing');setTimeout(()=>process.exit(0),100);return;}
if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');return res.end("let n=0;document.querySelector('#counter').onclick=e=>e.target.textContent='Count '+(++n)");}
res.setHeader('Content-Type','text/html');res.setHeader('Set-Cookie','DO_NOT_FORWARD=1');res.end(html);}).listen(3001,'127.0.0.1');
''')
    (root/'.env').write_text('PRIVATE_PROJECT_SENTINEL');(storage/'config/private-provider').write_text('PRIVATE_PROVIDER_SENTINEL');(storage/'workspace'/other/'private').write_text('OTHER_PROJECT_SENTINEL')
    proxy=subprocess.Popen(['/usr/bin/python3','-I',str(ROOT/'containers/broker/egress.py'),str(storage/'runtime/egress/proxy.sock')],env={'PATH':'/usr/bin:/bin'},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    for _ in range(100):
        if (storage/'runtime/egress/proxy.sock').exists():break
        time.sleep(.05)
    docker=Docker(str(storage),storage_id,str(ROOT),'default','sha256:'+subprocess.check_output(['docker','image','inspect','abyssus-worker:m35','--format','{{.Id}}'],text=True).strip().split(':')[1])
    journal=Journal(str(storage/'runtime/preview-claims.sqlite'),str(uuid.uuid4()));broker=Broker(journal,docker)
    check('preview helper and interpreter protected by source image attestation','opt/abyssus-worker/preview-http.py' in docker.attestor.base)
    unrelated=docker.call(['run','-d','--network','none','--entrypoint','/usr/bin/sleep',docker.image,'infinity']).strip()
    request,token,html=start();check('actual foreground Node dev server renders owned HTML',b'Owned worker server' in html)
    owned=docker.contexts[request['contextId']];info=docker.resources.verify(docker.resources.find(owned['container']))
    check('worker has no published port or network change',info['HostConfig']['NetworkMode']=='none' and not info['HostConfig'].get('PortBindings'))
    opened,js=read(token,'/app.js');check('actual relative JavaScript asset fetched',b'counter' in js and opened['contentType'].startswith('text/javascript'))
    opened,big=read(token,'/big');check('actual multi-page helper body within existing authenticated wire bounds',len(big)==200000)
    opened,stats=read(token,'/stats');stats=json.loads(stats);check('server sees only fixed Host GET and credential-free identity request',stats['headers']=={'host':'127.0.0.1:3001','accept':'*/*','accept-encoding':'identity','connection':'close'})
    for target in ['/redirect','/oversized','/.env','/@fs/etc/passwd','/%2Fapi','//127.0.0.1:3128/']:
        try:read(token,target);raise AssertionError('unsafe HTTP accepted '+target)
        except (Denied,ValueError):pass
    _,stats=read(token,'/stats');check('redirect private target receives no request',json.loads(stats)['privateHits']==0)
    try:broker.dispatch('preview_open',{**token,'path':'/','port':3128});raise AssertionError('arbitrary port accepted')
    except Denied:pass
    before=time.monotonic()
    try:read(token,'/slow');raise AssertionError('slow reply accepted')
    except Denied:pass
    check('actual malicious server deadline is finite',time.monotonic()-before<20)
    read(token,'/exit');outcome=terminal(token);check('actual natural process exit observed',outcome['state']=='finished' and outcome['result']['exitCode']==0)
    broker.dispatch('close',{'contextId':request['contextId']});check('exact natural-exit worker removed before restart',request['contextId'] not in docker.contexts)
    restarted,restarted_token,_=start(child=True);check('deliberate fresh restart uses a distinct exact process claim/context',restarted['claimId']!=request['claimId'] and restarted['contextId']!=request['contextId'])
    try:read(token);raise AssertionError('old claim adopted')
    except Denied:pass
    end=time.monotonic()+5
    while not (root/'late.txt').exists() and time.monotonic()<end:time.sleep(.05)
    broker.dispatch('cancel',restarted_token);outcome=terminal(restarted_token)
    check('cancel preserves observed outcome or uncertainty without success fabrication',outcome['state'] in ('finished','uncertain'))
    check('owned cancellation proves namespace removal',restarted['contextId'] not in docker.contexts)
    before=(root/'late.txt').read_bytes();time.sleep(.4);check('no late descendant writes after exact namespace drain',(root/'late.txt').read_bytes()==before)
    check('unrelated Docker workload remains running',json.loads(docker.call(['inspect',unrelated]))[0]['State']['Running'])
    try:read(restarted_token);raise AssertionError('stopped worker preview reused')
    except Denied:pass
    broker.shutdown();journal.db.close();broker=None
    recovered=Journal(str(storage/'runtime/preview-claims.sqlite'),str(uuid.uuid4()))
    check('new broker session cannot adopt old process/preview',all(json.loads(raw)['state'] not in ('accepted','running') for (raw,) in recovered.db.execute('SELECT data FROM claims')));recovered.db.close()
    (OUT/'m35-preview-worker.json').write_text(json.dumps({'source':source,'mode':'actual disposable Linux Docker owned worker/foreground Node HTTP/helper/broker lifecycle; separate from browser/device/provider proof','image':docker.image,'checks':checks,'cancelState':outcome['state'],'storage':str(storage)},indent=2))
except BaseException as error:
    (OUT/'m35-preview-worker-failure.json').write_text(json.dumps({'source':source,'error':str(error),'checks':checks,'storage':str(storage)},indent=2));raise
finally:
    if broker:
        try:broker.shutdown()
        except Exception:pass
    if unrelated:
        try:subprocess.run(['docker','rm','--force',unrelated],capture_output=True,timeout=30)
        except Exception:pass
    if proxy:proxy.terminate();proxy.wait(timeout=10)
