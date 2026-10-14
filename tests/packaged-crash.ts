/** Deliberately crash only this disposable fixture's owned installed app. */
import { _electron as electron, expect } from '@playwright/test';
import { readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import assert from 'node:assert/strict';
if(process.env.GITHUB_ACTIONS!=='true')throw new Error('Authorized disposable CI only');
const executable=path.resolve(process.argv[2]),home=process.env.ABYSSUS_PACKAGE_TEST_HOME!;assert(home);
const env=Object.fromEntries(Object.entries(process.env).filter((v):v is [string,string]=>typeof v[1]==='string'));delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:executable,args:['--user-data-dir='+home],env,chromiumSandbox:true});
let backend:number|undefined;
const deadline=setTimeout(()=>{console.error('FAIL owned crash recovery timed out');if(backend)try{process.kill(backend,'SIGCONT');}catch{}process.exit(1);},60000);
try {
  const page=await app.firstWindow();
  assert.equal(await app.evaluate(()=>process.pid),app.process().pid,'Crash must target the actual Electron main process');
  assert.equal(realpathSync.native(await app.evaluate(()=>process.execPath)).toLowerCase(),realpathSync.native(executable).toLowerCase());
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
  if(process.platform==='linux'){
    await page.getByLabel('Persistent profile home (Linux path)').fill(path.join(home,'linux-profile'));
    await page.getByLabel('Profile action').selectOption('existing');
    await page.getByRole('button',{name:'Open profile',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Optional system installs'})).toBeVisible({timeout:45000});
    const children=readdirSync('/proc').filter(p=>/^\d+$/.test(p)).flatMap(p=>{try{
      const status=readFileSync('/proc/'+p+'/status','utf8'),cmd=readFileSync('/proc/'+p+'/cmdline','utf8');
      return Number(status.match(/^PPid:\s+(\d+)/m)?.[1])===app.process().pid&&realpathSync('/proc/'+p+'/exe')==='/opt/abyssus/runtime/bin/node'&&cmd.includes('/opt/abyssus/app/desktop/backend-entry.js')?[Number(p)]:[];
    }catch{return [];}});
    assert.equal(children.length,1);backend=children[0];process.kill(backend,'SIGSTOP');
  }
  // No model/privileged work is running; pausing only the exact test backend
  // makes its surviving package lease observable after main dies.
  let observer:ReturnType<typeof spawn>|undefined,observerDone:Promise<unknown>|undefined,observations='';
  if(process.platform==='win32'){
    observer=spawn(path.join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-File',path.resolve('tests/windows-crash-observer.ps1')],{env:{...env,ABYSSUS_CRASH_PID:String(app.process().pid),ABYSSUS_CRASH_EXE:realpathSync.native(executable)},windowsHide:true,stdio:['ignore','pipe','pipe']});
    observerDone=once(observer,'close');
    observer.stdout!.on('data',data=>{observations+=data.toString();});observer.stderr!.on('data',data=>process.stderr.write(data));
    await expect.poll(()=>observations.includes('"event":"ready"'),{timeout:10000}).toBe(true);
  }
  const killedAt=Date.now();let exitAt:number|undefined,closeAt:number|undefined;
  app.process().once('exit',()=>{exitAt=Date.now()-killedAt;});app.process().once('close',()=>{closeAt=Date.now()-killedAt;});
  app.process().kill('SIGKILL');
  await expect.poll(()=>app.process().exitCode!==null||app.process().signalCode!==null).toBe(true);
  if(backend){
    let blocked=false;try{execFileSync('/usr/bin/sudo',['/usr/bin/python3','-I','/usr/lib/abyssus/maintenance.py','begin','backend'],{stdio:'pipe'});}catch{blocked=true;}assert(blocked);
    process.kill(backend,'SIGCONT');
    await expect.poll(()=>{try{return !existsSync('/proc/'+backend)||/^State:\s+Z/m.test(readFileSync('/proc/'+backend+'/status','utf8'));}catch{return true;}},{timeout:15000}).toBe(true);
    backend=undefined;
    console.log('PASS abnormal main exit retains surviving backend lease until actual pipe-loss drain completes');
  }else{
    const started=Date.now();let attempts=0,lastError='';
    const probeLease=()=>{attempts++;const probe=spawnSync(process.execPath,['-e',`if(!require(${JSON.stringify(path.join(path.dirname(executable),'resources/app/desktop/package-lease.node'))}).held)process.exit(1)`],{encoding:'utf8',timeout:3000});lastError=probe.stderr??String(probe.error??'');return probe.status;};
    const immediate=probeLease();
    if(observerDone){
      await observerDone;console.log('Exact owned process observations:',observations.trim());assert.equal(observer!.exitCode,0);
      const records=observations.trim().split(/\r?\n/).map(line=>JSON.parse(line));
      const before=records.find(r=>r.event==='ready'),after=records.find(r=>r.event==='process-handle');
      assert.equal(after.exited,true);assert.deepEqual(before.processes.filter((p:{kind:string})=>p.kind==='main').map((p:{pid:number})=>p.pid),[app.process().pid]);
      assert.equal(after.processes.filter((p:{kind:string})=>p.kind==='main').length,0,'No auto-launched or unclosed fixture main may retain ownership');
    }
    await expect.poll(()=>closeAt!==undefined,{timeout:10000}).toBe(true);
    console.log('Owned main termination timing:',{pid:app.process().pid,path:executable,exitMs:exitAt,closeMs:closeAt,immediateLeaseStatus:immediate});
    // TerminateProcess completion and kernel-handle teardown may be observed at
    // different times. Require actual reacquisition, never assume from exit alone.
    await expect.poll(()=>{
      return probeLease();
    },{timeout:15000,intervals:[100,250,500],message:'Native lease must become acquirable after actual main exit'}).toBe(0).catch(error=>{console.error(lastError);throw error;});
    console.log('PASS abnormal Windows main exit releases its native OS lease after',Date.now()-started,'ms across',attempts,'probe(s); no WSL backend was launched');
  }
}finally{
  if(backend)try{process.kill(backend,'SIGCONT');}catch{}
  clearTimeout(deadline);await app.close().catch(()=>{});
}
