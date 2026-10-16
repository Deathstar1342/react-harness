"""M30 actual controller/broker/source-PTY acceptance, called with owned CI storage."""
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import pty
import re
import select as selector
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'containers/broker'))
from transfer_service import select, authorize

CHECKS=[]
def check(name,condition=True):
    assert condition,name
    CHECKS.append(name);print('PASS M30:',name,flush=True)

def api_session(start_output):
    matches=re.findall(r'Browser pairing code \(single use, 5 minutes\): ([a-f0-9]{48})',start_output)
    match=matches[-1] if matches else None
    assert match,'pairing code missing'
    opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def api(route,body=None,method=None,fail=False):
        request=urllib.request.Request('http://127.0.0.1:3000/api'+route,data=json.dumps(body).encode() if body is not None else None,method=method,headers={'Content-Type':'application/json','Origin':'http://127.0.0.1:3000'})
        try:
            with opener.open(request,timeout=120) as response: result=json.load(response)
            assert not fail,'unexpected API success'
            return result
        except urllib.error.HTTPError as error:
            if not fail: raise AssertionError(str(error)+': '+error.read().decode()) from None
            return error.code
    api('/auth/pair',{'code':match})
    return api

def terminal_code(root,source):
    pid,fd=pty.fork()
    if pid==0:
        os.chdir(root);os.execvpe('bash',['bash','scripts/project-transfer.sh'],{'HOME':os.environ['HOME'],'PATH':'/usr/bin:/bin','TERM':'xterm'})
    output=bytearray();offset=0
    try:
        answers=[('[import/export]:','import\n'),('Absolute source folder:',str(source)+'\n'),('(blank for none):','\n'),('fresh repository:','INCLUDE HISTORY\n'),('15 minutes:','AUTHORIZE COPY\n')]
        for marker,answer in answers:
            end=time.monotonic()+30
            while marker.encode() not in output[offset:]:
                assert time.monotonic()<end,'transfer terminal prompt missing: '+marker
                if selector.select([fd],[],[],.1)[0]: output.extend(os.read(fd,8192))
            offset=len(output);os.write(fd,answer.encode())
        end=time.monotonic()+30
        while time.monotonic()<end:
            if selector.select([fd],[],[],.1)[0]:
                try: block=os.read(fd,8192)
                except OSError: break
                if not block:break
                output.extend(block)
        _,status=os.waitpid(pid,0);pid=0
        assert os.waitstatus_to_exitcode(status)==0,'transfer CLI failed'
        code=re.search(rb'Transfer code \(paste into the app\): ([a-f0-9]{64})',output)
        assert code,'transfer code missing'
        return code[1].decode()
    finally:
        os.close(fd)
        if pid:
            os.kill(pid,signal.SIGKILL);os.waitpid(pid,0)


def run(root,storage,controller,start_output):
    api=api_session(start_output)
    base=storage.parent
    source=base/'m30-unrelated-original';source.mkdir()
    source2=base/'m30-another-original';source2.mkdir()
    (source/'ordinary.txt').write_text('committed content\n')
    env={'PATH':'/usr/bin:/bin','HOME':str(base),'GIT_CONFIG_NOSYSTEM':'1'}
    for args in (['init','--initial-branch=main'],['add','ordinary.txt'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','safe fixture']):
        subprocess.run(['git',*args],cwd=source,env=env,check=True,capture_output=True)
    (source/'ordinary.txt').write_text('dirty working bytes\n')
    (source/'README.md').write_text('Example: OPENAI_API_KEY=your-key\n')
    (source/'.env').write_text('ordinary-project-secret=excluded\n')
    (source/'node_modules').mkdir();(source/'node_modules/cache').write_text('excluded')
    (source2/'other.txt').write_text('second unrelated source')
    before={str(p.relative_to(source)):(p.read_bytes(),p.stat().st_mtime_ns,p.stat().st_mode) for p in source.rglob('*') if p.is_file()}
    code=terminal_code(root,source)
    result=api('/project-transfers/import',{'name':'Copied with history','code':code})
    project=result['project'];managed=storage/'workspace'/Path(project['path']).name
    check('actual PTY host authorization imports into fresh managed project',managed.is_dir() and result['receipt']['history'])
    check('dirty working changes and placeholder README survive', (managed/'ordinary.txt').read_text()=='dirty working bytes\n' and (managed/'README.md').exists())
    check('dependencies and sensitive files visibly excluded',not (managed/'.env').exists() and not (managed/'node_modules').exists() and result['receipt']['excludedCount']>=2)
    history=subprocess.run(['git','log','--oneline'],cwd=managed,env=env,capture_output=True,text=True,check=True)
    check('safe local Git history preserved without source Git execution during transfer','safe fixture' in history.stdout)
    check('same capability cannot register or copy twice',api('/project-transfers/import',{'name':'Replay','code':code},fail=True)>=400)
    sid=(storage/'.storage-id').read_text().strip()
    token,ticket=select(str(storage),sid,str(root),'import',str(source2));authorize(storage,token,ticket)
    second=api('/project-transfers/import',{'name':'Unrelated second','code':token})['project']
    check('unrelated second source selectable without restart or extra mounts',len(api('/projects'))>=2 and second['id']!=project['id'])
    # Exercise actual worker on the managed directory, with no external source bind.
    script="""import {WorkspaceTools} from '/app/server/tools/index.ts';
const root=process.argv[2],tools=new WorkspaceTools();tools.configureSandbox({home:'/abyssus',projects:()=>[root],protectedPaths:[],executionMode:'container'});
try {const result=await tools.execute({projectRoot:root,chatId:'m30-worker',agentId:'fixture'}, {name:'run_shell',args:{command:'printf managed-worker > worker.txt; test -t 1'}});if(!result.ok)throw Error(result.output);}finally{await tools.dispose();}
"""
    worker=subprocess.run(['docker','exec','-i',controller,'node','--import','tsx','--input-type=module','-',project['path']],input=script,text=True,capture_output=True,timeout=60)
    check('real worker executes only in imported managed project',worker.returncode==0 and (managed/'worker.txt').read_text()=='managed-worker')
    chat=api('/projects/'+project['id']+'/chats',{'title':'Persistent imported conversation'})
    api('/projects/'+project['id']+'/editor',{'path':'ordinary.txt','owner':'m30-human','dirty':True})
    destination=base/'m30-export-copy'
    token,ticket=select(str(storage),sid,str(root),'export',str(destination),managed.name);authorize(storage,token,ticket)
    check('real dirty editor lease refuses export before consuming host ticket',api('/projects/'+project['id']+'/export',{'code':token},fail=True)>=400 and not destination.exists())
    api('/projects/'+project['id']+'/editor',{'path':'ordinary.txt','owner':'m30-human','dirty':False})
    exported=api('/projects/'+project['id']+'/export',{'code':token})
    check('explicit export preserves managed bytes and source separation',exported['phase']=='succeeded' and (destination/'worker.txt').read_text()=='managed-worker' and not (source/'worker.txt').exists())
    active_destination=base/'m30-active-export'
    active_code,active_ticket=select(str(storage),sid,str(root),'export',str(active_destination),managed.name);authorize(storage,active_code,active_ticket)
    active_script=script.replace('printf managed-worker > worker.txt; test -t 1','printf active > active-worker.txt; sleep 3; printf stopped > active-worker.txt')
    active=subprocess.Popen(['docker','exec','-i',controller,'node','--import','tsx','--input-type=module','-',project['path']],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        active.stdin.write(active_script);active.stdin.close();active.stdin=None
        deadline=time.monotonic()+20
        while not (managed/'active-worker.txt').exists():
            assert active.poll() is None and time.monotonic()<deadline,'worker did not start'
            time.sleep(.02)
        check('actual active worker prevents host export admission',api('/projects/'+project['id']+'/export',{'code':active_code},fail=True)>=400 and not active_destination.exists())
        preview=api('/projects/'+project['id']+'/deletion-preview',{})
        check('pending export quarantine prevents managed deletion',api('/projects/'+project['id'],{'mode':'disk','canonicalPath':preview['canonicalPath'],'confirmationToken':preview['confirmationToken']},method='DELETE',fail=True)>=400 and managed.exists())
        check('pending export quarantine prevents reset',api('/projects/'+project['id']+'/sandbox/reset',{},fail=True)>=400)
        _,err=active.communicate(timeout=30);assert active.returncode==0,err
        released=api('/projects/'+project['id']+'/transfer-release',{'code':active_code})
        check('explicit host release revokes unconsumed export after real worker drains',released=={'released':True,'receipt':None} and not active_destination.exists() and (managed/'active-worker.txt').read_text()=='stopped')
        check('released transfer code cannot recopy',api('/projects/'+project['id']+'/export',{'code':active_code},fail=True)>=400 and not active_destination.exists())
    finally:
        if active.poll() is None:active.kill();active.wait(timeout=10)
    collision=base/'m30-collision'
    token,ticket=select(str(storage),sid,str(root),'export',str(collision),managed.name);authorize(storage,token,ticket)
    collision.mkdir();(collision/'keep').write_text('never replace')
    check('destination appearing after authorization is never overwritten',api('/projects/'+project['id']+'/export',{'code':token},fail=True)>=400 and (collision/'keep').read_text()=='never replace')
    check('original source bytes mtime and mode preserved',before=={str(p.relative_to(source)):(p.read_bytes(),p.stat().st_mtime_ns,p.stat().st_mode) for p in source.rglob('*') if p.is_file()})
    # Delete only second managed copy through actual exact-path confirmation.
    preview=api('/projects/'+second['id']+'/deletion-preview',{})
    api('/projects/'+second['id'],{'mode':'disk','canonicalPath':preview['canonicalPath'],'confirmationToken':preview['confirmationToken']},method='DELETE')
    check('managed removal never deletes the original source',source2.is_dir() and (source2/'other.txt').read_text()=='second unrelated source' and not (storage/'workspace'/Path(second['path']).name).exists())
    return {'project':project,'chat':chat,'source':str(source),'managed':str(managed)}


def reopen(start_output,state):
    api=api_session(start_output)
    check('restart retains exact imported project and chat identity',any(p['id']==state['project']['id'] for p in api('/projects')) and any(c['id']==state['chat']['id'] for c in api('/projects/'+state['project']['id']+'/chats')))
    check('restart retains managed edits independently from original',Path(state['managed'],'worker.txt').read_text()=='managed-worker' and not Path(state['source'],'worker.txt').exists())
