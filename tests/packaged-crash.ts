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
let backend:number|undefined;
const deadline=setTimeout(()=>{console.error('FAIL owned crash recovery timed out');if(backend)try{process.kill(backend,'SIGCONT');}catch{}process.exit(1);},60000);
console.log(new Date().toISOString(),'START crash launch', {executable,home});
const app=await electron.launch({executablePath:executable,args:['--user-data-dir='+home],env,chromiumSandbox:true,timeout:30000});
const launcher=app.process();let mainKilled=false;
try {
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
  const identity=await app.evaluate(()=>({pid:process.pid,path:process.execPath}));
  console.log(new Date().toISOString(),'END crash launch; actual identity',identity,'launcher PID',launcher.pid);
  if(process.platform!=='win32')assert.equal(identity.pid,launcher.pid);
  assert.equal(realpathSync.native(identity.path).toLowerCase(),realpathSync.native(executable).toLowerCase());
  const page=await app.firstWindow({timeout:15000});
  await expect(page.getByRole('heading',{name:'Open your workspace'})).toBeVisible({timeout:15000});
  if(process.platform==='linux'){
    await page.getByLabel('Persistent profile home (Linux path)').fill(path.join(home,'linux-profile'));
    await page.getByLabel('Profile action').selectOption('existing');
    await page.getByRole('button',{name:'Open profile',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Optional system installs'})).toBeVisible({timeout:45000});
    const children=readdirSync('/proc').filter(p=>/^\d+$/.test(p)).flatMap(p=>{try{
      const status=readFileSync('/proc/'+p+'/status','utf8'),cmd=readFileSync('/proc/'+p+'/cmdline','utf8');
      return Number(status.match(/^PPid:\s+(\d+)/m)?.[1])===identity.pid&&realpathSync('/proc/'+p+'/exe')==='/opt/abyssus/runtime/bin/node'&&cmd.includes('/opt/abyssus/app/desktop/backend-entry.js')?[Number(p)]:[];
    }catch{return [];}});
    assert.equal(children.length,1);backend=children[0];process.kill(backend,'SIGSTOP');
  }
  // No model/privileged work is running; pausing only the exact test backend
  // makes its surviving package lease observable after main dies.
  let observer:ReturnType<typeof spawn>|undefined,observerDone:Promise<unknown>|undefined,observations='';
  if(process.platform==='win32'){
    observer=spawn(path.join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-File',path.resolve('tests/windows-crash-observer.ps1')],{env:{...env,ABYSSUS_CRASH_PID:String(identity.pid),ABYSSUS_CRASH_PARENT:String(launcher.pid),ABYSSUS_CRASH_EXE:realpathSync.native(executable)},windowsHide:true,stdio:['ignore','pipe','pipe']});
    observerDone=once(observer,'close');
    console.log(new Date().toISOString(),'START process-handle observer',observer.pid);
    observer.stdout!.on('data',data=>{observations+=data.toString();process.stdout.write('OBSERVER '+data.toString());});observer.stderr!.on('data',data=>process.stderr.write(data));
    await expect.poll(()=>observations.includes('"event":"ready"'),{timeout:10000}).toBe(true);
  }
  const killedAt=Date.now();let exitAt:number|undefined,closeAt:number|undefined;
  launcher.once('exit',()=>{exitAt=Date.now()-killedAt;});launcher.once('close',()=>{closeAt=Date.now()-killedAt;});
  // Windows Playwright launches through cmd.exe. The observer verified that
  // Electron's reported main PID/path is the direct child of this owned launcher.
  process.kill(identity.pid,'SIGKILL');mainKilled=true;
  console.log(new Date().toISOString(),'Requested termination of exact owned main',identity.pid,'launcher',launcher.pid);
  await expect.poll(()=>launcher.exitCode!==null||launcher.signalCode!==null,{timeout:10000}).toBe(true);
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
      assert.equal(after.exited,true);assert.deepEqual(before.processes.filter((p:{kind:string})=>p.kind==='main').map((p:{pid:number})=>p.pid),[identity.pid]);
      assert.equal(after.processes.filter((p:{kind:string})=>p.kind==='main').length,0,'No auto-launched or unclosed fixture main may retain ownership');
    }
    await expect.poll(()=>closeAt!==undefined,{timeout:10000}).toBe(true);
    console.log('Owned main termination timing:',{mainPid:identity.pid,launcherPid:launcher.pid,path:executable,launcherExitMs:exitAt,launcherCloseMs:closeAt,immediateLeaseStatus:immediate});
    // TerminateProcess completion and kernel-handle teardown may be observed at
    // different times. Require actual reacquisition, never assume from exit alone.
    await expect.poll(()=>{
      return probeLease();
    },{timeout:15000,intervals:[100,250,500],message:'Native lease must become acquirable after actual main exit'}).toBe(0).catch(error=>{console.error(lastError);throw error;});
    console.log('PASS abnormal Windows main exit releases its native OS lease after',Date.now()-started,'ms across',attempts,'probe(s); no WSL backend was launched');
  }
}catch(error){console.error(new Date().toISOString(),'FAIL crash phase before cleanup',error);throw error;}
finally{
  if(backend)try{process.kill(backend,'SIGCONT');}catch{}
  if(!mainKilled&&launcher.exitCode===null&&launcher.signalCode===null){
    console.log(new Date().toISOString(),'START normal cleanup through owned launcher',launcher.pid);
    try{await Promise.race([app.close(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Fixture cleanup timed out; transaction quarantined')),5000))]);}
    catch(error){console.error(error);process.exit(1);}
  }
  console.log(new Date().toISOString(),'END crash fixture',{exitCode:launcher.exitCode,signal:launcher.signalCode});
  clearTimeout(deadline);
}
