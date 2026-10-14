/** Actual production executable/entry. No smoke-entry.cjs substitutions. */
import { _electron as electron, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const executable=process.argv[2];if(!executable)throw new Error('Provide an actual packaged executable');
const setup=path.join(path.dirname(path.resolve(executable)),'resources/setup');
const setupEntries=readFileSync(path.join(setup,'SHA256SUMS'),'utf8').trim().split('\n').map(line=>{
  const match=/^([a-f0-9]{64})  ([^/\\]+)$/.exec(line);assert(match,'Invalid setup checksum record');return {name:match[2],hash:match[1]};
});
assert.deepEqual(setupEntries.map(e=>e.name).sort(),readdirSync(setup).filter(name=>name!=='SHA256SUMS').sort(),'Every bundled setup file must have one checksum');
for(const entry of setupEntries)assert.equal(createHash('sha256').update(readFileSync(path.join(setup,entry.name))).digest('hex'),entry.hash,`Bundled checksum mismatch: ${entry.name}`);
console.log('PASS actual packaged setup payload has complete matching checksums');
const mode=process.argv[3]??'create';assert(['create','verify'].includes(mode));
const home=process.env.ABYSSUS_PACKAGE_TEST_HOME??mkdtempSync(path.join(tmpdir(),'abyssus-package-'));
mkdirSync(home,{recursive:true});
if(mode==='create')writeFileSync(path.join(home,'preserve.txt'),'package-preservation-fixture',{flag:'wx'});
else assert.equal(readFileSync(path.join(home,'preserve.txt'),'utf8'),'package-preservation-fixture');
const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));delete env.ELECTRON_RUN_AS_NODE;
const launch=()=>electron.launch({executablePath:path.resolve(executable),args:['--user-data-dir='+home],cwd:tmpdir(),env,chromiumSandbox:true,timeout:45000});
for(let i=0;i<2;i++){
  const app=await launch();
  const deadline=setTimeout(()=>{console.error('FAIL packaged smoke exceeded two minutes');app.process().kill();process.exit(1);},120000);
  try{
    await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
    const page=await app.firstWindow();
    await expect(page.getByRole('heading',{name:'Open your workspace'})).toBeVisible({timeout:20000});
    const info=await app.evaluate(({app,BrowserWindow})=>({packaged:app.isPackaged,data:app.getPath('userData'),session:app.getPath('sessionData'),sandbox:(BrowserWindow.getAllWindows()[0].webContents as unknown as {getLastWebPreferences:()=>{sandbox:boolean}}).getLastWebPreferences().sandbox}));
    assert(info.packaged);assert(info.sandbox);assert.equal(realpathSync.native(info.data).toLowerCase(),realpathSync.native(home).toLowerCase());
    if(i===0){
      const runtime=await app.evaluate(({app})=>{const {createRequire}=process.getBuiltinModule('node:module');const {join}=process.getBuiltinModule('node:path');const addon=createRequire(join(app.getAppPath(),'package.json'))('./desktop/package-lease.node');return {electron:process.versions.electron,node:process.versions.node,napi:process.versions.napi,leaseHeld:addon.held,exports:Object.keys(addon)};});
      assert.equal(runtime.electron,'42.11.13');assert.equal(runtime.node,'24.19.0');assert.equal(runtime.napi,'10');assert.equal(runtime.leaseHeld,true);assert.deepEqual(runtime.exports,['held']);
      console.log('PASS actual packaged stable N-API8 addon load and acquired lease:',runtime);
    }
    if(process.platform==='win32')assert.equal(info.data,info.session);
    assert.equal(await page.evaluate(()=>typeof (globalThis as Record<string,unknown>).require),'undefined');
    assert.equal(readFileSync(path.join(home,'preserve.txt'),'utf8'),'package-preservation-fixture');
    if(i===0){
      await app.evaluate(({app})=>{(globalThis as Record<string,unknown>).secondLaunch=false;app.once('second-instance',()=>{(globalThis as Record<string,unknown>).secondLaunch=true;});});
      const second=spawn(path.resolve(executable),['--user-data-dir='+home],{env,stdio:'ignore'});
      const [code]=await once(second,'exit');assert.equal(code,0);
      assert.equal(await app.evaluate(()=>(globalThis as Record<string,unknown>).secondLaunch),true);
      if(process.platform==='win32'&&process.env.ABYSSUS_TEST_INSTALLER){
        assert.equal(process.env.GITHUB_ACTIONS,'true');
        const attempt=async(file:string,args:string[])=>{const child=spawn(file,args,{env,stdio:'ignore'});return (await once(child,'exit'))[0];};
        const other=path.join(path.dirname(path.dirname(path.resolve(executable))),'other-app');
        assert.equal(await attempt(process.env.ABYSSUS_TEST_INSTALLER,['/S','/D='+other]),74);
        // An unrelated child exit cannot release the process-owned native lease.
        execFileSync(process.execPath,['-e','process.exit(0)']);
        const uninstall=readdirSync(path.dirname(executable)).find(n=>/^Uninstall.*\.exe$/.test(n));assert(uninstall);
        assert.equal(await attempt(path.join(path.dirname(executable),uninstall),['/S','_?='+path.dirname(path.resolve(executable))]),73);
        assert.equal(await page.getByRole('heading',{name:'Open your workspace'}).isVisible(),true);
        console.log('PASS process-owned maintenance refusal after unrelated child exit; second instance focuses existing app');
      }
    }
    if(process.platform==='linux'){
      await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
      await page.getByLabel('Persistent profile home (Linux path)').fill(path.join(home,'linux-profile'));
      const creating=mode==='create'&&i===0;
      await page.getByLabel('Profile action').selectOption(creating?'initialize':'existing');
      await page.getByRole('button',{name:'Open profile',exact:true}).click();
      await expect(page.getByRole('heading',{name:'Optional system installs'})).toBeVisible({timeout:45000});
      const state=await page.evaluate(()=>window.abyssusDesktop!.status());assert.equal(state.phase,'ready');
      assert(state.checks?.slice(0,5).every(c=>c.ok));
      const receipt=path.join(home,'accepted-state.json');
      if(creating){
        const recorded=await page.evaluate(async({home})=>{
          const request=async(url:string,method='GET',body?:unknown)=>{const r=await fetch('/api'+url,{method,...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});if(!r.ok)throw new Error('Fixture API failed: '+url);return r.json();};
          await request('/provider-settings','PATCH',{models:{architect:'package-architect',coder:'package-coder',critic:'package-critic'},baseUrl:'http://127.0.0.1:9/v1',apiKey:'synthetic-package-test-key'});
          const preferences=await request('/preferences','PATCH',{debugMode:true,defaultApprovalMode:'review'});
          const workspace=await request('/workspace','PATCH',{workspaceRoot:home+'/projects'});
          const project=await request('/projects','POST',{name:'Package persistence',mode:'create'});
          const chat=await request('/projects/'+project.id+'/chats','POST',{title:'Retain this chat'});
          const file=await request('/projects/'+project.id+'/file','PUT',{path:'kept.txt',content:'Preserved through actual package maintenance.\n',baseHash:null,owner:'package-acceptance'});
          await request('/provider-settings','PATCH',{models:{architect:'new-default-architect'}});
          return {project,chat,file,preferences,workspace};
        },{home});
        const configHash=createHash('sha256').update(readFileSync(path.join(home,'linux-profile/profile/config/.env'))).digest('hex');
        writeFileSync(receipt,JSON.stringify({...recorded,configHash}),{flag:'wx'});
      }else{
        const recorded=JSON.parse(readFileSync(receipt,'utf8'));
        assert.equal(createHash('sha256').update(readFileSync(path.join(home,'linux-profile/profile/config/.env'))).digest('hex'),recorded.configHash);
        const restored=await page.evaluate(async(recorded)=>{
          const get=async(url:string)=>{const r=await fetch('/api'+url);if(!r.ok)throw new Error('Restore API failed');return r.json();};
          return {projects:await get('/projects'),detail:await get('/chats/'+recorded.chat.id),file:await get('/projects/'+recorded.project.id+'/file?path=kept.txt'),preferences:await get('/preferences'),workspace:await get('/workspace'),provider:await get('/provider-settings')};
        },recorded);
        assert.deepEqual(restored.projects.find((p:{id:string})=>p.id===recorded.project.id),recorded.project);
        assert.deepEqual(restored.detail.chat,recorded.chat);assert.deepEqual(restored.file,recorded.file);
        assert.deepEqual(restored.preferences,recorded.preferences);assert.deepEqual(restored.workspace,recorded.workspace);
        assert.equal(restored.provider.apiKeyConfigured,true);assert.equal(restored.provider.models.architect,'new-default-architect');assert.equal(restored.detail.chat.models.architect,'package-architect');
        assert.equal(readFileSync(path.join(recorded.project.path,'kept.txt'),'utf8'),recorded.file.content);
        console.log('PASS same profile/project/chat IDs, model snapshot, settings, configured synthetic key and exact project file restored');
      }
      console.log('PASS installed Linux backend, SQLite/native PTY/runtime/sandbox checks');
    }
    await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
  } catch(error){console.error(error);throw error;}
  finally {await app.close();clearTimeout(deadline);}
}
console.log('PASS actual packaged production entry, isolated data directory, sandbox and restart');
