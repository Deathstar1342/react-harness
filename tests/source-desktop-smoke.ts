import { _electron as electron,expect,type Page } from '@playwright/test';
import {mkdirSync,readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.env.M32_RUNTIME,out=process.env.M32_RECEIPTS;
if(!root||!out)throw new Error('Explicit runtime/receipt roots required');
mkdirSync(out,{recursive:true});
const payload=path.join(root,'payload'),exe=path.join(payload,'electron',process.platform==='win32'?'electron.exe':'electron');
const support=path.join(payload,'support-runtime',process.platform==='win32'?'python.exe':'bin/python3.13');
const probe=spawnSync(support,['-I','-B','-c','import sqlite3,ssl,ctypes,zlib,sys; assert sys.flags.isolated; print(sys.version)'],{cwd:root,env:{...process.env,PYTHONPATH:root,PYTHONHOME:root},encoding:'utf8',timeout:30000});
assert.equal(probe.status,0,probe.stderr);
// Launch the ACTUAL exported source entry and its own dependency closure, no junction.
const launch=()=>electron.launch({executablePath:exe,args:[path.join(payload,'app/desktop/source-entry.cjs')],cwd:root,chromiumSandbox:true,env:{...process.env,TEMP:path.join(root,'temp'),TMP:path.join(root,'temp'),TMPDIR:path.join(root,'temp')},timeout:45000});
let stage='launch',page:Page|undefined;
let app=await launch();
const mark=(value:string)=>{stage=value;console.log('M32 source stage: '+stage);};
const connected=async()=>{
 assert(page&&!page.isClosed());const current=page;
 await expect.poll(async()=>['ready','failed'].includes((await current.evaluate(()=>window.abyssusDesktop!.status())).phase),{timeout:240000,intervals:[250,500,1000]}).toBe(true);
 assert.equal((await current.evaluate(()=>window.abyssusDesktop!.status())).phase,'ready','Controller did not reach ready');
 await expect(current.getByRole('heading',{name:'Your workspace is connected'})).toBeVisible();
};
try{
 mark('onboarding');page=await app.firstWindow();await expect(page.getByRole('heading',{name:'Open your workspace'})).toBeVisible();
 assert.equal(await app.evaluate(({app})=>app.getPath('userData')),path.join(root,'desktop-data'));
 assert.equal(await page.evaluate(()=>typeof (globalThis as Record<string,unknown>).require),'undefined');
 const preferences=await app.evaluate(({BrowserWindow})=>(BrowserWindow.getAllWindows()[0].webContents as unknown as {getLastWebPreferences:()=>Record<string,unknown>}).getLastWebPreferences());
 assert.equal(preferences.sandbox,true);assert.equal(preferences.contextIsolation,true);assert.equal(preferences.nodeIntegration,false);
 const status=await page.evaluate(()=>window.abyssusDesktop!.status());assert.equal(status.runtime,'container');
 if(process.platform==='linux')assert.equal(status.container?.available,true,'Local container inventory unavailable');
 if(process.platform==='linux'){
  assert.equal(process.env.GITHUB_ACTIONS,'true','Engine lifecycle fixture requires the disposable CI environment');
  const context=readFileSync(path.join(root,'receipt'),'utf8').split('\n')[2];assert.match(context,/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
  const engine=(args:string[])=>{const result=spawnSync('docker',['--context',context,...args],{encoding:'utf8',timeout:20000,maxBuffer:262144,env:{HOME:process.env.HOME,PATH:process.env.PATH}});assert.equal(result.status,0,'Scoped fixture engine operation failed');return result.stdout.trim();};
  assert.equal(engine(['image','ls','--no-trunc','--filter','reference=abyssus-worker:m29','--format','{{.ID}}']),'','Initial desktop startup must work without a discovery tag');
  mark('select-new-storage');
  const storage=path.join(path.dirname(root),'m32-managed-storage');mkdirSync(storage,{mode:0o700});
  await app.evaluate(({dialog},selected)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[selected]});dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});},storage);
  await page.getByRole('button',{name:'Choose storage folder'}).click();mark('initial-controller-start');await page.getByRole('button',{name:'Open workspace',exact:true}).click();
  await connected();
  mark('create-persistent-fixture');
  const project=await page.evaluate(async()=>{const response=await fetch('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Source persistent fixture',mode:'create'})});if(!response.ok)throw new Error('Project creation failed');return response.json();});
  const chat=await page.evaluate(async id=>{const response=await fetch('/api/projects/'+id+'/chats',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Idle source fixture'})});if(!response.ok)throw new Error('Chat creation failed');return response.json();},project.id);
  const marker=readFileSync(path.join(storage,'.storage-id'),'utf8'),settings=readFileSync(path.join(storage,'config/.env'),'utf8');
  mark('restart-controller');
  const reopened=app.waitForEvent('window',{timeout:240000});await page.getByRole('button',{name:'Restart runtime',exact:true}).click();page=await reopened;
  await connected();
  const projects=await page.evaluate(async()=>{const response=await fetch('/api/projects');return response.json();});
  assert(projects.some((item:{id:string})=>item.id===project.id));assert.equal(readFileSync(path.join(storage,'.storage-id'),'utf8'),marker);assert.equal(readFileSync(path.join(storage,'config/.env'),'utf8'),settings);
  mark('clean-close');await app.close();mark('conflicting-tag-isolation');
  const unrelated=readFileSync(path.join(root,'controller.iid'),'utf8').trim();assert.match(unrelated,/^sha256:[a-f0-9]{64}$/);
  engine(['image','tag',unrelated,'abyssus-worker:m29']);
  mark('relaunch');app=await launch();page=await app.firstWindow();
  await expect(page.getByRole('heading',{name:'Open your workspace'})).toBeVisible();
  const retained=await page.evaluate(()=>window.abyssusDesktop!.status());assert.equal(retained.container?.storage?.id,marker.trim());
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
  mark('reopen-existing-storage');await page.getByRole('button',{name:'Open workspace',exact:true}).click();
  await connected();
  mark('verify-persistence');
  const detail=await page.evaluate(async id=>{const response=await fetch('/api/chats/'+id);return response.json();},chat.id);
  const goal=await page.evaluate(async id=>{const response=await fetch('/api/chats/'+id+'/goal');return response.json();},chat.id);
  assert.equal(engine(['image','inspect','abyssus-worker:m29','--format','{{.Id}}']),unrelated,'Desktop must preserve unrelated discovery binding');
  assert.equal(detail.chat.id,chat.id);assert.equal(detail.chat.status,'idle');assert.equal(goal.goal,null);
  assert.equal(readFileSync(path.join(storage,'.storage-id'),'utf8'),marker);assert.equal(readFileSync(path.join(storage,'config/.env'),'utf8'),settings);
 }
 mark('success-capture');
 await page.screenshot({path:path.join(out,`source-${process.platform}.png`)});
 writeFileSync(path.join(out,`source-${process.platform}.json`),JSON.stringify({platform:process.platform,source:JSON.parse(readFileSync(path.join(payload,'provenance.json'),'utf8')).source,privatePython:probe.stdout.trim(),nativeElectron:true,ownDependencyClosure:true,containerInventoryAvailable:status.container?.available,windowsDockerAcceptance:false,actualLinuxStorageRestart:process.platform==='linux',actualLinuxCloseReopen:process.platform==='linux',dialogReturns:'synthetic',idleChatNoAutomaticGoal:process.platform==='linux',noTagStartup:process.platform==='linux',conflictingTagPreserved:process.platform==='linux',scope:'Actual exported source entry. No human picker, live provider or installed-package acceptance.'},null,2));
 await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});await app.close();
 }catch(error){
 // Keep failure evidence bounded and explicitly projected. Never serialize status.message,
 // provider values, launch capabilities, raw owner/config files, URLs or exception text.
 const bounded=async<T>(operation:Promise<T>):Promise<T|undefined>=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([operation.catch(()=>undefined),new Promise<undefined>(resolve=>{timer=setTimeout(()=>resolve(undefined),5000);})]);}finally{clearTimeout(timer);}};
 const status=page&&!page.isClosed()?await bounded(page.evaluate(async()=>{
  const state=await window.abyssusDesktop!.status();
  const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  return {runtime:state.runtime==='container'?'container':'unknown',phase:['setup','starting','ready','stopping','failed'].includes(state.phase)?state.phase:'unknown',available:state.container?.available===true,storageSelected:!!state.container?.storage,storageId:uuid.test(state.container?.storage?.id??'')?state.container!.storage!.id:undefined,transitioning:state.transitioning===true};
 })):undefined;
 const knownCodes=new Set(['ENGINE_CONTEXT_FAILED','ENGINE_INFO_FAILED','ENGINE_IMAGE_FAILED','ENGINE_INITIALIZE_FAILED','ENGINE_CREATE_FAILED','ENGINE_START_FAILED','ENGINE_INITIALIZE_MODULE_MISSING','ENGINE_INITIALIZE_PROFILE_REFUSED','ENGINE_INITIALIZE_MOUNT_REFUSED','ENGINE_INITIALIZE_PERMISSION_REFUSED','ENGINE_REPLY_LIMIT','ENGINE_OPERATION_FAILED','SUPERVISION_UNCERTAIN','INVALID_LAUNCH','INVALID_IMAGE','INVALID_WORKER_IMAGE','WORKER_IMAGE_CHANGED','RUNTIME_IMAGE_MISSING','BROKER_START_FAILED','BROKER_START_TIMEOUT','BROKER_IDENTITY_CHANGED','CONTROLLER_NOT_READY','CONTROLLER_NOT_RUNNING','OWNERSHIP_CHANGED','CLEANUP_UNCERTAIN','UNSAFE_STORAGE','STORAGE_CHANGED']);
 const codes=page&&!page.isClosed()?await bounded(page.getByRole('alert').allTextContents().then(lines=>[...new Set(lines.join(' ').match(/\b[A-Z][A-Z_]{2,63}\b/g)??[])].filter(code=>knownCodes.has(code)).slice(0,16))):undefined;
 const storage=path.join(path.dirname(root),'m32-managed-storage');
 const files=Object.fromEntries(['state','config','workspace','runtime','.storage-id','state/container-storage.json','runtime/desktop-owner.json','runtime/desktop-owner.sqlite','runtime/control/session.json','state/backend.json'].map(name=>[name,existsSync(path.join(storage,name))]));
 let owner:Record<string,unknown>|undefined;
 const ownerFile=path.join(storage,'runtime/desktop-owner.json');
 if(existsSync(ownerFile)&&statSync(ownerFile).size<=4096){try{const value=JSON.parse(readFileSync(ownerFile,'utf8'));owner={phase:['create-intent','created','start-intent','running'].includes(value.phase)?value.phase:'unknown',containerId:typeof value.id==='string'&&/^[a-f0-9]{64}$/.test(value.id)?value.id:undefined,image:typeof value.image==='string'&&/^sha256:[a-f0-9]{64}$/.test(value.image)?value.image:undefined};}catch{/* Preserve unparseable original; no raw contents exported. */}}
 const provenance=JSON.parse(readFileSync(path.join(payload,'provenance.json'),'utf8'));
 writeFileSync(path.join(out,`source-failure-${process.platform}.json`),JSON.stringify({stage,platform:process.platform,source:provenance.source,status,codes,files,owner,errorKind:error instanceof Error&&['Error','AssertionError','ExpectError','TimeoutError'].includes(error.name)?error.name:'test-failure'},null,2));
 if(page&&!page.isClosed())await bounded(page.screenshot({path:path.join(out,`source-failure-${process.platform}.png`),timeout:5000,mask:[page.locator('input,textarea')]}));
 await bounded(app.evaluate(({app})=>app.exit(1)));
 throw new Error('Source desktop acceptance failed at '+stage+'; see bounded redacted receipt and screenshot.');
}
console.log('PASS exported source runtime: actual native Electron, private Python imports, isolated renderer, selected desktop data, own dependency closure');
