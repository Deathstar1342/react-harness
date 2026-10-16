import { _electron as electron,expect } from '@playwright/test';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
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
let app=await launch();
try{
 let page=await app.firstWindow();await expect(page.getByRole('heading',{name:'Open your workspace'})).toBeVisible();
 assert.equal(await app.evaluate(({app})=>app.getPath('userData')),path.join(root,'desktop-data'));
 assert.equal(await page.evaluate(()=>typeof (globalThis as Record<string,unknown>).require),'undefined');
 const preferences=await app.evaluate(({BrowserWindow})=>(BrowserWindow.getAllWindows()[0].webContents as unknown as {getLastWebPreferences:()=>Record<string,unknown>}).getLastWebPreferences());
 assert.equal(preferences.sandbox,true);assert.equal(preferences.contextIsolation,true);assert.equal(preferences.nodeIntegration,false);
 const status=await page.evaluate(()=>window.abyssusDesktop!.status());assert.equal(status.runtime,'container');
 if(process.platform==='linux')assert.equal(status.container?.available,true,JSON.stringify(status));
 if(process.platform==='linux'){
  const storage=path.join(path.dirname(root),'m32-managed-storage');mkdirSync(storage,{mode:0o700});
  await app.evaluate(({dialog},selected)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[selected]});dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});},storage);
  await page.getByRole('button',{name:'Choose storage folder'}).click();await page.getByRole('button',{name:'Open workspace',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Your workspace is connected'})).toBeVisible({timeout:240000});
  const project=await page.evaluate(async()=>{const response=await fetch('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Source persistent fixture',mode:'create'})});if(!response.ok)throw new Error('Project creation failed');return response.json();});
  const chat=await page.evaluate(async id=>{const response=await fetch('/api/projects/'+id+'/chats',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Idle source fixture'})});if(!response.ok)throw new Error('Chat creation failed');return response.json();},project.id);
  const marker=readFileSync(path.join(storage,'.storage-id'),'utf8'),settings=readFileSync(path.join(storage,'config/.env'),'utf8');
  const reopened=app.waitForEvent('window');await page.getByRole('button',{name:'Restart runtime',exact:true}).click();page=await reopened;
  await expect(page.getByRole('heading',{name:'Your workspace is connected'})).toBeVisible({timeout:240000});
  const projects=await page.evaluate(async()=>{const response=await fetch('/api/projects');return response.json();});
  assert(projects.some((item:{id:string})=>item.id===project.id));assert.equal(readFileSync(path.join(storage,'.storage-id'),'utf8'),marker);assert.equal(readFileSync(path.join(storage,'config/.env'),'utf8'),settings);
  await app.close();app=await launch();page=await app.firstWindow();
  await expect(page.getByRole('heading',{name:'Open your workspace'})).toBeVisible();
  const retained=await page.evaluate(()=>window.abyssusDesktop!.status());assert.equal(retained.container?.storage?.id,marker.trim());
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
  await page.getByRole('button',{name:'Open workspace',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Your workspace is connected'})).toBeVisible({timeout:240000});
  const detail=await page.evaluate(async id=>{const response=await fetch('/api/chats/'+id);return response.json();},chat.id);
  const goal=await page.evaluate(async id=>{const response=await fetch('/api/chats/'+id+'/goal');return response.json();},chat.id);
  assert.equal(detail.chat.id,chat.id);assert.equal(detail.chat.status,'idle');assert.equal(goal.goal,null);
  assert.equal(readFileSync(path.join(storage,'.storage-id'),'utf8'),marker);assert.equal(readFileSync(path.join(storage,'config/.env'),'utf8'),settings);
 }
 await page.screenshot({path:path.join(out,`source-${process.platform}.png`)});
 writeFileSync(path.join(out,`source-${process.platform}.json`),JSON.stringify({platform:process.platform,source:JSON.parse(readFileSync(path.join(payload,'provenance.json'),'utf8')).source,privatePython:probe.stdout.trim(),nativeElectron:true,ownDependencyClosure:true,containerInventoryAvailable:status.container?.available,windowsDockerAcceptance:false,actualLinuxStorageRestart:process.platform==='linux',actualLinuxCloseReopen:process.platform==='linux',dialogReturns:'synthetic',idleChatNoAutomaticGoal:process.platform==='linux',scope:'Actual exported source entry. No human picker, live provider or installed-package acceptance.'},null,2));
 await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});await app.close();
}catch(error){await app.evaluate(({app})=>app.exit(1)).catch(()=>{});throw error;}
console.log('PASS exported source runtime: actual native Electron, private Python imports, isolated renderer, selected desktop data, own dependency closure');
