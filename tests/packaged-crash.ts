/** Deliberately crash only this disposable fixture's owned installed app. */
import { _electron as electron, expect } from '@playwright/test';
import { readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
  app.process().kill('SIGKILL');
  await expect.poll(()=>app.process().exitCode!==null||app.process().signalCode!==null).toBe(true);
  if(backend){
    let blocked=false;try{execFileSync('/usr/bin/sudo',['/usr/bin/python3','-I','/usr/lib/abyssus/maintenance.py','begin','backend'],{stdio:'pipe'});}catch{blocked=true;}assert(blocked);
    process.kill(backend,'SIGCONT');
    await expect.poll(()=>{try{return !existsSync('/proc/'+backend)||/^State:\s+Z/m.test(readFileSync('/proc/'+backend+'/status','utf8'));}catch{return true;}},{timeout:15000}).toBe(true);
    backend=undefined;
    console.log('PASS abnormal main exit retains surviving backend lease until actual pipe-loss drain completes');
  }else{
    execFileSync(process.execPath,['-e',`if(!require(${JSON.stringify(path.join(path.dirname(executable),'resources/app/desktop/package-lease.node'))}).held)process.exit(1)`],{stdio:'pipe'});
    console.log('PASS abnormal Windows main exit releases its native OS lease; no WSL backend was launched');
  }
}finally{
  if(backend)try{process.kill(backend,'SIGCONT');}catch{}
  clearTimeout(deadline);await app.close().catch(()=>{});
}
