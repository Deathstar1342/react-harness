"""Bounded disposable-Linux observations of fixture-owned Git maintenance.

No transfer retry, ignored source members, lock deletion or global config change.
Unobserved uncontrolled races remain explicitly unobserved, never called proof.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time

POLICY=['-c','maintenance.auto=false','-c','gc.auto=0','-c','maintenance.autoDetach=false','-c','gc.autoDetach=false']
LIMIT=512*1024

def trace_events(trace):
    if not trace.exists():return []
    assert trace.stat().st_size<=LIMIT,'fixture Git trace exceeds bound'
    raw=trace.read_text();lines=raw.splitlines()
    if raw and not raw.endswith('\n'):lines=lines[:-1] # A live writer's partial line is not an observation.
    return [json.loads(line) for line in lines if line.strip()]

def maintenance_starts(events):
    return [event for event in events if event.get('event') in ('start','child_start') and any(arg=='maintenance' or arg.endswith('/git-maintenance') for arg in event.get('argv',[]))]

def snapshot(source):
    result={}
    for member in source.rglob('*'):
        assert not member.is_symlink(),'unexpected link in owned fixture'
        info=member.stat()
        if stat.S_ISREG(info.st_mode):result[str(member.relative_to(source))]=(hashlib.sha256(member.read_bytes()).hexdigest(),info.st_mtime_ns,info.st_mode)
        else:assert stat.S_ISDIR(info.st_mode),'unexpected special file in owned fixture'
    assert len(result)<=256,'owned fixture member bound exceeded'
    return result

def observed_lock_owners(source,events):
    """Read only PIDs named by this fixture's Trace2 maintenance starts.

    Never enumerate/adopt/signal arbitrary processes. PID reuse/cwd mismatch is
    excluded; lack of an observed owner is not proof that no process existed.
    """
    result=[]
    for event in maintenance_starts(events):
        matches=re.findall(r'-P([0-9a-fA-F]+)(?:/|$)',event.get('sid',''))
        if not matches:continue
        pid=int(matches[-1],16)
        try:
            if pid<=1 or Path(os.readlink(f'/proc/{pid}/cwd')).resolve()!=source.resolve():continue
            descriptors=list(Path(f'/proc/{pid}/fd').iterdir())
            if len(descriptors)>256:continue
            for descriptor in descriptors:
                try:target=os.readlink(descriptor)
                except OSError:continue
                if target==str(source/'.git/objects/maintenance.lock'):result.append({'pid':pid,'sid':event.get('sid'),'fd':descriptor.name})
        except (OSError,ValueError):continue
    return result

def trial(base,index,controlled,deadline):
    source=base/f'{"controlled" if controlled else "uncontrolled"}-{index}';source.mkdir()
    home=base/'home';home.mkdir(exist_ok=True)
    trace=base/f'{source.name}-trace.jsonl'
    env={'PATH':'/usr/bin:/bin','HOME':str(home),'GIT_CONFIG_NOSYSTEM':'1','GIT_TERMINAL_PROMPT':'0','GIT_TRACE2_EVENT':str(trace)}
    (source/'ordinary.txt').write_text('committed content\n')
    commands=[['init','--initial-branch=main'],['add','ordinary.txt'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','safe fixture']]
    for args in commands:
        remaining=deadline-time.monotonic();assert remaining>0,'diagnostic total deadline exceeded'
        completed=subprocess.run(['git',*(POLICY if controlled else []),*args],cwd=source,env=env,check=True,capture_output=True,timeout=min(10,remaining))
        assert len(completed.stdout)+len(completed.stderr)<=16384,'fixture Git output bound exceeded'
    lock=source/'.git/objects/maintenance.lock';initial_lock=lock.exists();samples=[];owners=[];before=None
    try:before=snapshot(source)
    except FileNotFoundError:pass # A disappearing uncontrolled member is evidence, not silently a stable snapshot.
    end=min(time.monotonic()+.5,deadline)
    while time.monotonic()<end:
        events=trace_events(trace);present=lock.exists()
        if present:owners.extend(observed_lock_owners(source,events))
        samples.append(present);time.sleep(.01) # Observation only, never a transfer retry/delay.
    events=trace_events(trace);starts=maintenance_starts(events)
    exits={event.get('sid') for event in events if event.get('event')=='atexit'}
    start_sids={event.get('sid') for event in starts if event.get('event')=='start'}
    after=snapshot(source)
    summary={'fixture':source.name,'controlled':controlled,'commandLocalPolicy':POLICY if controlled else [],'initialLock':initial_lock,'lockObserved':initial_lock or any(samples),'finalLock':lock.exists(),'stableSnapshot':before is not None and before==after,
        'traceMaintenanceStarts':[{'event':event.get('event'),'sid':event.get('sid'),'argv':event.get('argv'),'childId':event.get('child_id')} for event in starts],
        'maintenanceStartSidsWithExit':sorted(start_sids&exits),'maintenanceStartSidsWithoutObservedExit':sorted(start_sids-exits),'directlyObservedLockOwners':list({(item['pid'],item['sid'],item['fd']):item for item in owners}.values())}
    child_starts=[event for event in starts if event.get('event')=='child_start']
    summary['maintenanceLifecycle']='unknown' if len(child_starts)!=len(start_sids) or summary['maintenanceStartSidsWithoutObservedExit'] else 'fully observed' if starts else 'not observed'
    summary['quiescent']=controlled and not starts and not summary['finalLock']
    return summary

def main():
    assert sys.platform=='linux' and os.environ.get('GITHUB_ACTIONS')=='true','Requires an authorized disposable Linux CI runner'
    output=Path(__file__).resolve().parents[1]/'test-results/container/git-fixture-maintenance.json';output.parent.mkdir(parents=True,exist_ok=True)
    base=Path(tempfile.mkdtemp(prefix='m33-git-fixture-',dir=os.environ.get('RUNNER_TEMP')))
    deadline=time.monotonic()+90
    receipt={'platform':sys.platform,'gitVersion':subprocess.run(['/usr/bin/git','--version'],check=True,capture_output=True,text=True,timeout=5).stdout.strip(),'fixtureRoot':str(base),'fixtureRetention':'Preserved for disposable runner cleanup; uncontrolled lifecycle is never assumed quiescent','trialObservationMs':500,'totalDeadlineSeconds':90,'trials':[],'cause':'unobserved','completed':False}
    try:
        for index in range(12):
            item=trial(base,index,False,deadline);receipt['trials'].append(item)
            proven_owners=[owner for owner in item['directlyObservedLockOwners'] if owner['sid'] in item['maintenanceStartSidsWithExit']]
            if proven_owners and item['lockObserved'] and not item['finalLock']:
                receipt['cause']='directly observed fixture-owned auto-maintenance process holding disappearing maintenance.lock';receipt['provenCauseSid']=proven_owners[0]['sid'];break
        for index in range(3):
            item=trial(base,index,True,deadline);receipt['trials'].append(item)
            assert not item['traceMaintenanceStarts'],'controlled fixture launched auto-maintenance'
            assert not item['lockObserved'] and not item['finalLock'],'controlled fixture has a maintenance lock'
            assert item['stableSnapshot'],'controlled full bytes/mtime/mode snapshot changed'
        assert time.monotonic()<deadline,'diagnostic total deadline exceeded'
        receipt['completed']=True
        print('PASS fixture command-local maintenance quiescence and full stable snapshots; uncontrolled cause:',receipt['cause'],flush=True)
    finally:
        output.write_text(json.dumps(receipt,indent=2))
        # Preserve every trace; they contain only known synthetic Git commands.
        for trace in base.glob('*-trace.jsonl'):
            assert trace.stat().st_size<=LIMIT,'trace exceeds receipt bound'
            shutil.copyfile(trace,output.parent/f'git-fixture-{trace.name}')
        # Uncontrolled late child starts cannot be declared quiescent. Preserve
        # all owned fixtures/traces for the disposable runner's cleanup instead.

if __name__=='__main__':main()
