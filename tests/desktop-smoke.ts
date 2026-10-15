import { randomUUID } from 'node:crypto';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync,writeFileSync,readFileSync,existsSync,unlinkSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
// This entrypoint runs with Node's native TypeScript loader, without tsx resolution.
function diagnosticReply(input:{tools?:unknown[]}) {
  return {text:input.tools?.length?'':'Connection OK',finishReason:input.tools?.length?'tool_calls':'stop',
    toolCalls:input.tools?.length?[{id:`call_${randomUUID()}`,type:'function' as const,function:{name:'connection_echo',arguments:JSON.stringify({value:'Connection OK'})}}]:[],
    usage:{inputTokens:15,outputTokens:10}};
}
const root=path.resolve(import.meta.dirname,'..'),home=mkdtempSync(path.join(tmpdir(),'abyssus-electron-'));
mkdirSync(path.join(root,'test-results'),{recursive:true});
const launch=()=>electron.launch({args:[path.join(root,'tests/desktop-electron-entry.cjs')],chromiumSandbox:true,cwd:tmpdir(),env:{...process.env,ABYSSUS_SMOKE_HOME:home,MODEL_STREAMING:'false'},timeout:30000});
let app=await launch();
const close=async()=>{await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});await app.close();};
const crashRenderer=()=>app.evaluate(({BrowserWindow})=>{
  const contents=BrowserWindow.getAllWindows()[0].webContents;
  // Kill only the exact owned renderer. SIGKILL avoids Linux crash/core-dump
  // handlers delaying the renderer-exit notification in a disposable runner.
  if(process.platform==='linux'){const pid=contents.getOSProcessId();if(!pid||pid===process.pid)throw new Error('Invalid renderer PID');process.kill(pid,'SIGKILL');}
  else contents.forcefullyCrashRenderer();
});
let completed=false;
const deadline=setTimeout(()=>{console.error('FAIL desktop smoke exceeded its two-minute bound');void app.evaluate(({app})=>app.exit(1)).finally(()=>process.exit(1));},120000);
try {
  let page=await app.firstWindow();
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')console.error('Renderer error: '+message.text());});
  page.on('requestfailed',request=>console.error('Request failed: '+new URL(request.url()).pathname+' '+request.failure()?.errorText));
  await expect(page.getByRole('heading',{name:'Open your workspace'})).toBeVisible();
  assert.equal(await page.evaluate(()=>typeof (globalThis as Record<string,unknown>).require),'undefined');
  assert.equal(await page.evaluate(()=>typeof (globalThis as Record<string,unknown>).process),'undefined');
  const prefs=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return (w.webContents as unknown as {getLastWebPreferences:()=>Record<string,unknown>}).getLastWebPreferences();});
  assert.equal(prefs.sandbox,true);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);
  const chrome=await app.evaluate(({BrowserWindow,nativeTheme,Menu})=>{
    const w=BrowserWindow.getAllWindows()[0];return {theme:nativeTheme.themeSource,dark:nativeTheme.shouldUseDarkColors,menu:w.isMenuBarVisible(),autoHide:w.isMenuBarAutoHide(),closable:w.isClosable(),minimizable:w.isMinimizable(),maximizable:w.isMaximizable(),quit:Menu.getApplicationMenu()?.items[0].submenu?.items.find(item=>item.label==='Quit')?.accelerator};
  });
  assert.equal(chrome.theme,'dark');assert.equal(chrome.dark,true);assert.equal(chrome.quit,'CmdOrCtrl+Q');
  if(process.platform==='win32'){assert.equal(chrome.menu,false);assert.equal(chrome.autoHide,true);assert(chrome.closable&&chrome.minimizable&&chrome.maximizable);}
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
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
  const shellRecovery=app.waitForEvent('window');
  await crashRenderer();
  page=await shellRecovery;await expect(page.getByRole('heading',{name:'Open your workspace'})).toBeVisible();
  console.log(`PASS real ${process.platform} renderer crash and fresh window recovery`);
  if(process.platform==='linux') {
    // Native confirmation/picker results are synthetic; Electron, backend, auth,
    // SQLite, actual PTY/runtime and sandbox below are real.
    await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
    const profile=path.join(home,'profile'),project=mkdtempSync(path.join(tmpdir(),'abyssus-desktop-project-'));
    writeFileSync(path.join(project,'sample.json'),'{"value":1}');
    try {
      await page.getByLabel('Persistent profile home (Linux path)').fill(profile);
      await page.getByLabel('Profile action').selectOption('initialize');
      await page.getByRole('button',{name:'Open profile',exact:true}).click();
      await expect(page.getByRole('heading',{name:'Optional system installs'})).toBeVisible({timeout:45000});
      const ready=await page.evaluate(()=>window.abyssusDesktop!.status());
      console.log('CHECK connected backend readiness');
      assert.equal(ready.phase,'ready');assert(ready.checks?.slice(0,5).every(c=>c.ok));
      if(!ready.helperReadiness?.setup.canStart){
        await expect(page.getByRole('button',{name:'Enable helper',exact:true})).toBeDisabled();
        await expect(page.getByRole('button',{name:'Continue to chats'})).toBeEnabled();
        const unavailable=await page.evaluate(()=>window.abyssusDesktop!.helper('setup'));
        assert.equal(unavailable.phase,'ready');assert.equal(unavailable.sessionId,ready.sessionId);
        assert.equal(await page.evaluate(()=>fetch('/api/projects').then(r=>r.status)),200);
        console.log('PASS unavailable optional helper preserves real connected backend/session and API');
      }
      await page.getByRole('button',{name:'Continue to chats'}).click();
      const ids=await page.evaluate(async(project)=>{
        const send=async(url:string,body:unknown)=>{const r=await fetch('/api'+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error(await r.text());return r.json();};
        const p=await send('/projects',{name:'Desktop smoke',path:project,mode:'import'});
        const c=await send(`/projects/${p.id}/chats`,{title:'Preserve desktop state'});return {project:p.id,chat:c.id};
      },project);
      console.log('CHECK project/chat created; reading SSE');
      const streamed=await page.evaluate(async chat=>{const abort=new AbortController();const response=await fetch(`/api/chats/${chat}/events`,{signal:abort.signal});const reader=response.body!.getReader();const first=await reader.read();await reader.cancel();abort.abort();return new TextDecoder().decode(first.value);},ids.chat);
      assert(streamed.includes(': connected'));
      console.log('CHECK SSE first chunk and cancellation completed');
      await page.reload();
      await expect(page.getByRole('navigation',{name:'Conversations'}).getByRole('button',{name:'Preserve desktop state',exact:true})).toBeVisible({timeout:15000});
      await page.getByRole('navigation',{name:'Conversations'}).getByRole('button',{name:'Preserve desktop state',exact:true}).click();
      await page.getByRole('button',{name:'Toggle files',exact:true}).click();
      const worker=page.waitForEvent('worker',{timeout:15000});
      await page.getByRole('button',{name:'sample.json',exact:true}).click();
      const editor=page.locator('.monaco-editor textarea').first();await expect(editor).toBeVisible({timeout:15000});
      assert((await worker).url().startsWith('abyssus://app/'));
      console.log('PASS real packaged JSON language worker loaded');
      await page.locator('.monaco-editor .view-lines').first().click();
      // A JSON scalar avoids editor auto-pairing changing synthetic inserted text.
      await page.keyboard.press('ControlOrMeta+A');await page.keyboard.insertText('42');
      await expect(page.getByLabel('Unsaved changes')).toBeVisible();
      await assert.rejects(page.evaluate(()=>window.abyssusDesktop!.helper('setup')));
      // M26: skill and file editors contribute independently to the actual
      // preload/main-process transition guard, including unsaved draft fields.
      await page.getByRole('button',{name:'Skills',exact:true}).click();
      await page.getByLabel('Skill name').fill('desktop-workflow');
      await page.getByLabel('Skill description').fill('Preserve unsaved desktop work');
      await assert.rejects(page.evaluate(()=>window.abyssusDesktop!.helper('setup')));
      await page.getByRole('button',{name:'Close Skills',exact:true}).click();
      await page.getByRole('button',{name:'Discard and close',exact:true}).click();
      // Cleaning the skill editor must not clear the still-dirty Monaco editor.
      await assert.rejects(page.evaluate(()=>window.abyssusDesktop!.helper('setup')));
      await page.getByRole('button',{name:'Save',exact:true}).click();
      await expect(page.getByLabel('Unsaved changes')).toHaveCount(0);assert.equal(readFileSync(path.join(project,'sample.json'),'utf8'),'42');
      console.log('PASS real Monaco open, worker-backed editor input, dirty guard and version-checked save');
      await page.getByRole('button',{name:'Skills',exact:true}).click();
      await page.getByLabel('Workflow steps').fill('Unsaved workflow draft');
      await assert.rejects(page.evaluate(()=>window.abyssusDesktop!.helper('setup')));
      await page.getByRole('button',{name:'Close Skills',exact:true}).click();await page.getByRole('button',{name:'Discard and close',exact:true}).click();
      console.log('PASS real Electron independent skill/file dirty aggregation, unsaved draft close guard and retained editor state');
      const provider=createServer(async(req,res)=>{
        if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:['gemini-3.5-pro','gemini-3.5-flash-withtools'].map(id=>({id}))}));return;}
        let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),result=diagnosticReply(body);
        const message={role:'assistant',content:result.text,...(result.toolCalls.length?{tool_calls:result.toolCalls}:{})};
        if(body.stream){res.setHeader('content-type','text/event-stream');res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{...message,...(result.toolCalls.length?{tool_calls:result.toolCalls.map((call,index)=>({...call,index}))}:{})},finish_reason:result.finishReason}],usage:{prompt_tokens:10,completion_tokens:10}})}\n\ndata: [DONE]\n\n`);}
        else{res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message,finish_reason:result.finishReason}],usage:{prompt_tokens:10,completion_tokens:10}}));}
      });provider.listen(0,'127.0.0.1');await once(provider,'listening');
      try {
        await page.getByRole('button',{name:'Settings',exact:true}).click();
        await page.getByLabel('STARK API endpoint').fill(`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`);
        await page.getByLabel('Replacement API key').fill('synthetic-desktop-only');
        await page.getByRole('button',{name:'Save provider settings',exact:true}).click();
        await expect(page.getByText('Provider settings saved. Model defaults apply to new chats only.')).toBeVisible();
        await page.getByRole('button',{name:'Test connection',exact:true}).click();
        await expect(page.getByText('Connection checks passed',{exact:true})).toBeVisible({timeout:30000});
        for(const role of ['architect','coder','critic'])for(const evidence of ['ordinary','native','streaming']) {
          await expect(page.getByText(`${role} · ${evidence} · passed`,{exact:true})).toBeVisible();
        }
        await page.getByRole('button',{name:'Close',exact:true}).click();
        console.log('PASS blank-profile endpoint/key through real Settings and explicit synthetic HTTP connection test');
      }finally{provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));}
      const beforeCrash=(await page.evaluate(()=>window.abyssusDesktop!.status())).sessionId;
      const originalBackendPid=JSON.parse(readFileSync(path.join(profile,'backend.json'),'utf8')).identity.pid,crashedPage=page;
      const recoveredWindow=app.waitForEvent('window');
      await crashRenderer();
      page=await recoveredWindow;
      await expect.poll(()=>crashedPage.isClosed()).toBe(true);
      await expect(page.getByRole('navigation',{name:'Conversations'}).getByRole('button',{name:'Preserve desktop state',exact:true})).toBeVisible({timeout:20000});
      assert.equal((await page.evaluate(()=>window.abyssusDesktop!.status())).sessionId,beforeCrash);
      assert.equal(JSON.parse(readFileSync(path.join(profile,'backend.json'),'utf8')).identity.pid,originalBackendPid);
      console.log('PASS actual renderer crash/reopen retains exact backend session');
      await app.evaluate(({dialog})=>{dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});});
      assert.equal(await page.evaluate(()=>window.abyssusDesktop!.pickDirectory()),null);
      await page.evaluate(()=>window.abyssusDesktop!.dirty(true));
      await assert.rejects(page.evaluate(()=>window.abyssusDesktop!.helper('setup')));
      await page.evaluate(()=>window.abyssusDesktop!.dirty(false));
      await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:0,checkboxChecked:false});});
      const cancelled=await page.evaluate(()=>window.abyssusDesktop!.helper('setup'));
      assert.equal(cancelled.phase,'ready');assert.equal(cancelled.sessionId,beforeCrash);
      console.log('PASS native helper confirmation cancellation preserves backend and authority');
      await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
      // Exact private descriptor is read by this test process only; never logged.
      const descriptor=JSON.parse(readFileSync(path.join(profile,'backend.json'),'utf8'));
      assert.equal((await fetch(descriptor.address+'/api/projects')).status,401);
      assert.equal((await fetch(descriptor.address+`/api/chats/${ids.chat}/events`)).status,401);
      const duplicate=spawn(app.process().spawnfile,[path.join(root,'tests/desktop-electron-entry.cjs')],{env:{...process.env,ABYSSUS_SMOKE_HOME:home},stdio:'ignore'});
      const duplicateExit=await once(duplicate,'exit');assert.equal(duplicateExit[0],0);
      assert.equal((await page.evaluate(()=>window.abyssusDesktop!.status())).sessionId,beforeCrash);
      console.log('PASS actual second application instance exits without a second backend');
      await page.screenshot({path:path.join(root,'test-results/electron-linux-connected.png')});
      console.log('PASS real Linux staged Node/SQLite/PTY prerequisites, authenticated API+streaming SSE, unauthenticated denial, native-picker cancellation adapter and dirty setup guard');
      console.log('CHECK waiting deliberate backend shutdown');
      writeFileSync(path.join(home,'hold-stop'),'hold');
      await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
      await expect.poll(()=>existsSync(path.join(home,'ready-stop'))).toBe(true);
      assert.equal(await page.evaluate(()=>document.documentElement.inert),true);
      await page.evaluate(()=>window.abyssusDesktop!.dirty(true));
      unlinkSync(path.join(home,'hold-stop'));
      await expect.poll(()=>page.evaluate(()=>document.documentElement.inert)).toBe(false);
      assert.equal(page.isClosed(),false);await page.evaluate(()=>window.abyssusDesktop!.dirty(false));
      console.log('PASS edit arriving during delayed cleanup vetoes destructive close and allows explicit retry');
      await close();
      console.log('CHECK explicit close retry completed');
      app=await launch();const reopened=await app.firstWindow();
      await expect(reopened.getByLabel('Persistent profile home (Linux path)')).toHaveValue(profile);
      await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
      await reopened.getByRole('button',{name:'Open profile',exact:true}).click();
      await expect(reopened.getByRole('heading',{name:'Optional system installs'})).toBeVisible({timeout:45000});
      const chats=await reopened.evaluate(async id=>fetch('/api/projects/'+id+'/chats').then(r=>r.json()),ids.project);
      assert(chats.some((chat:{id:string})=>chat.id===ids.chat));
      await reopened.getByRole('button',{name:'Continue to chats'}).click();page=reopened;
      // Crash only the exact backend child of this disposable Electron process.
      // Each restart must replace the document, even when reopening the same profile.
      let oldSession=(await page.evaluate(()=>window.abyssusDesktop!.status())).sessionId;
      for(const nextHome of [profile,path.join(home,'second-profile')]) {
        if(nextHome===profile){
          await page.getByRole('button',{name:'Toggle files',exact:true}).click();
          await page.getByRole('button',{name:'sample.json',exact:true}).click();
          await expect(page.locator('.monaco-editor textarea').first()).toBeVisible();
        }
        const receipt=JSON.parse(readFileSync(path.join(profile,'backend.json'),'utf8'));
        const parent=readFileSync(`/proc/${receipt.identity.pid}/status`,'utf8').match(/^PPid:\s+(\d+)/m)?.[1];
        assert.equal(Number(parent),app.process().pid);process.kill(receipt.identity.pid,'SIGKILL');
        await expect.poll(()=>page.evaluate(()=>window.abyssusDesktop!.status()).then(s=>s.phase)).toBe('failed');
        if(nextHome===profile){
          await page.getByRole('button',{name:'Return to editor buffers'}).click();
          const oldEditor=await page.locator('.monaco-editor').first().elementHandle();
          writeFileSync(path.join(home,'hold-start'),'hold');
          await page.evaluate(home=>{
            (window as unknown as {m20Start?:Promise<string>}).m20Start=window.abyssusDesktop!.start({environment:{kind:'linux'},home,mode:'existing'}).then(()=> 'unexpected commit',e=>String(e));
          },profile);
          console.log('CHECK waiting for held prepared backend');
          await expect.poll(()=>existsSync(path.join(home,'ready-start')),{timeout:30000}).toBe(true);
          console.log('CHECK prepared backend held; verifying old editor/session');
          assert.equal(await page.evaluate(()=>document.documentElement.inert),true);
          assert.equal((await page.evaluate(()=>window.abyssusDesktop!.status())).sessionId,oldSession);
          assert.equal(await page.evaluate(()=>fetch('/api/projects').then(r=>r.status)),503);
          // Cross the real two-second status-poll interval; a prepared session
          // must not remount React and lose the original editor element/buffer.
          await page.waitForTimeout(2200);
          assert(await oldEditor!.evaluate(element=>element.isConnected));
          console.log('CHECK polled editor retained; injecting late edit');
          await page.evaluate(()=>window.abyssusDesktop!.dirty(true));
          unlinkSync(path.join(home,'hold-start'));
          const rejected=await page.evaluate(()=>(window as unknown as {m20Start:Promise<string>}).m20Start);
          assert.match(rejected,/editor changed/);assert.equal(page.isClosed(),false);
          assert(await oldEditor!.evaluate(element=>element.isConnected));
          assert.equal(await page.evaluate(()=>document.documentElement.inert),false);
          assert.equal((await page.evaluate(()=>window.abyssusDesktop!.status())).sessionId,oldSession);
          await page.evaluate(()=>window.abyssusDesktop!.dirty(false));
          await page.getByRole('button',{name:/^Desktop ·/}).click();
          console.log('PASS delayed startup freezes input, quarantines API/session, preserves polled editor and rejects late dirty commit');
        }
        await page.getByLabel('Persistent profile home (Linux path)').fill(nextHome);
        await page.getByLabel('Profile action').selectOption(nextHome===profile?'existing':'initialize');
        const priorPage=page,replacement=app.waitForEvent('window');
        await page.getByRole('button',{name:'Open profile',exact:true}).click();page=await replacement;
        await expect.poll(()=>priorPage.isClosed()).toBe(true);
        await expect.poll(()=>page.evaluate(()=>window.abyssusDesktop!.status()).then(s=>s.phase)).toBe('ready');
        const nextSession=(await page.evaluate(()=>window.abyssusDesktop!.status())).sessionId;
        assert.notEqual(nextSession,oldSession);oldSession=nextSession;
        const projects=await page.evaluate(()=>fetch('/api/projects').then(r=>r.json()));
        if(nextHome===profile){assert(projects.some((p:{id:string})=>p.id===ids.project));}
        else {assert.deepEqual(projects,[]);await expect(page.getByRole('button',{name:'Preserve desktop state',exact:true})).toHaveCount(0);}
      }
      console.log('PASS real same-profile and two-profile recovery replaces renderer document and old backend session');
      await close();
      console.log('PASS deliberate actual backend drain and profile/chat persistence across desktop restart');
      app=await launch();
    } finally{rmSync(project,{recursive:true,force:true});}
  }
  await close();
  app=await launch();await expect((await app.firstWindow()).getByRole('heading',{name:'Open your workspace'})).toBeVisible();
  console.log('PASS real application restart with isolated desktop profile');
  completed=true;
} catch(error) {
  console.error('SMOKE assertion failed before cleanup:',error);throw error;
} finally {
  if(!completed)await app.windows()[0]?.screenshot({path:path.join(root,`test-results/electron-${process.platform}-failure.png`)}).catch(()=>{});
  for(const operation of ['start','stop']){const marker=path.join(home,'hold-'+operation);if(existsSync(marker))unlinkSync(marker);}
  await close().catch(()=>{});
  clearTimeout(deadline);
  if(completed)rmSync(home,{recursive:true,force:true});
  else console.log('Failed disposable desktop profile retained at '+home);
}
