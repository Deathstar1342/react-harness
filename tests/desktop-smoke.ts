import { _electron as electron, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync,writeFileSync,readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'),home=mkdtempSync(path.join(tmpdir(),'abyssus-electron-'));
mkdirSync(path.join(root,'test-results'),{recursive:true});
const launch=()=>electron.launch({args:[path.join(root,'tests/desktop-electron-entry.cjs')],cwd:tmpdir(),env:{...process.env,ABYSSUS_SMOKE_HOME:home},timeout:30000});
let app=await launch();
let completed=false;
try {
  const page=await app.firstWindow();
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await expect(page.getByRole('heading',{name:'Open your workspace'})).toBeVisible();
  assert.equal(await page.evaluate(()=>typeof (globalThis as Record<string,unknown>).require),'undefined');
  assert.equal(await page.evaluate(()=>typeof (globalThis as Record<string,unknown>).process),'undefined');
  const prefs=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return (w.webContents as unknown as {getLastWebPreferences:()=>Record<string,unknown>}).getLastWebPreferences();});
  assert.equal(prefs.sandbox,true);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);
  const status=await page.evaluate(()=>window.abyssusDesktop!.status());
  assert(!JSON.stringify(status).includes('token'));assert(!status.distributions.some(name=>/podman/i.test(name)));
  await page.evaluate(()=>{window.open('https://example.com');});
  assert.equal(app.windows().length,1);
  const external=await page.evaluate(async()=>{try{await fetch('https://example.com');return true;}catch{return false;}});assert.equal(external,false);
  const savedURL=page.url();await page.evaluate(()=>{location.href='https://example.com';});await new Promise(r=>setTimeout(r,250));assert.equal(page.url(),savedURL);
  await page.screenshot({path:path.join(root,`test-results/electron-${process.platform}.png`)});
  assert.deepEqual(errors,[]);
  console.log(`PASS real ${process.platform} Electron render, sandbox, IPC status, navigation/window/network denial, changed cwd`);
  // Window reload preserves the same trusted shell and does not launch a backend.
  await page.reload();await expect(page.getByRole('heading',{name:'Open your workspace'})).toBeVisible();
  console.log('PASS real window restart');
  if(process.platform==='linux') {
    // Native confirmation/picker results are synthetic; Electron, backend, auth,
    // SQLite, actual PTY/runtime and sandbox below are real.
    await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
    const profile=path.join(home,'profile'),project=mkdtempSync(path.join(tmpdir(),'abyssus-desktop-project-'));
    writeFileSync(path.join(project,'sample.txt'),'original');
    try {
      await page.getByLabel('Persistent profile home (Linux path)').fill(profile);
      await page.getByLabel('Profile action').selectOption('initialize');
      await page.getByRole('button',{name:'Open profile',exact:true}).click();
      await expect(page.getByRole('heading',{name:'Optional system installs'})).toBeVisible({timeout:45000});
      const ready=await page.evaluate(()=>window.abyssusDesktop!.status());
      assert.equal(ready.phase,'ready');assert(ready.checks?.slice(0,5).every(c=>c.ok));
      await page.getByRole('button',{name:'Continue to chats'}).click();
      const ids=await page.evaluate(async(project)=>{
        const send=async(url:string,body:unknown)=>{const r=await fetch('/api'+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error(await r.text());return r.json();};
        const p=await send('/projects',{name:'Desktop smoke',path:project,mode:'import'});
        const c=await send(`/projects/${p.id}/chats`,{title:'Preserve desktop state'});return {project:p.id,chat:c.id};
      },project);
      const streamed=await page.evaluate(async chat=>{const abort=new AbortController();const response=await fetch(`/api/chats/${chat}/events`,{signal:abort.signal});const reader=response.body!.getReader();const first=await reader.read();await reader.cancel();abort.abort();return new TextDecoder().decode(first.value);},ids.chat);
      assert(streamed.includes(': connected'));
      await app.evaluate(({dialog})=>{dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});});
      assert.equal(await page.evaluate(()=>window.abyssusDesktop!.pickDirectory()),null);
      await page.evaluate(()=>window.abyssusDesktop!.dirty(true));
      await assert.rejects(page.evaluate(()=>window.abyssusDesktop!.helper('setup')));
      await page.evaluate(()=>window.abyssusDesktop!.dirty(false));
      // Exact private descriptor is read by this test process only; never logged.
      const descriptor=JSON.parse(readFileSync(path.join(profile,'backend.json'),'utf8'));
      assert.equal((await fetch(descriptor.address+'/api/projects')).status,401);
      assert.equal((await fetch(descriptor.address+`/api/chats/${ids.chat}/events`)).status,401);
      await page.screenshot({path:path.join(root,'test-results/electron-linux-connected.png')});
      console.log('PASS real Linux staged Node/SQLite/PTY prerequisites, authenticated API+streaming SSE, unauthenticated denial, native-picker cancellation adapter and dirty setup guard');
      await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
      await new Promise<void>(resolve=>{const child=app.process();if(child.exitCode!==null)resolve();else child.once('exit',()=>resolve());});
      app=await launch();const reopened=await app.firstWindow();
      await expect(reopened.getByLabel('Persistent profile home (Linux path)')).toHaveValue(profile);
      await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
      await reopened.getByRole('button',{name:'Open profile',exact:true}).click();
      await expect(reopened.getByRole('heading',{name:'Optional system installs'})).toBeVisible({timeout:45000});
      const chats=await reopened.evaluate(async id=>fetch('/api/projects/'+id+'/chats').then(r=>r.json()),ids.project);
      assert(chats.some((chat:{id:string})=>chat.id===ids.chat));
      await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
      await new Promise<void>(resolve=>{const child=app.process();if(child.exitCode!==null)resolve();else child.once('exit',()=>resolve());});
      console.log('PASS deliberate actual backend drain and profile/chat persistence across desktop restart');
      app=await launch();
    } finally{rmSync(project,{recursive:true,force:true});}
  }
  await app.evaluate(({app})=>app.exit(0));
  app=await launch();await expect((await app.firstWindow()).getByRole('heading',{name:'Open your workspace'})).toBeVisible();
  console.log('PASS real application restart with isolated desktop profile');
  completed=true;
} finally {
  await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});
  if(completed)rmSync(home,{recursive:true,force:true});
  else console.log('Failed disposable desktop profile retained at '+home);
}
