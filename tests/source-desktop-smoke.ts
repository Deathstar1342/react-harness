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
const app=await electron.launch({executablePath:exe,args:[path.join(payload,'app/desktop/source-entry.cjs')],cwd:root,chromiumSandbox:true,env:{...process.env,TEMP:path.join(root,'temp'),TMP:path.join(root,'temp'),TMPDIR:path.join(root,'temp')},timeout:45000});
try{
 const page=await app.firstWindow();await expect(page.getByRole('heading',{name:'Open your workspace'})).toBeVisible();
 assert.equal(await app.evaluate(({app})=>app.getPath('userData')),path.join(root,'desktop-data'));
 assert.equal(await page.evaluate(()=>typeof (globalThis as Record<string,unknown>).require),'undefined');
 const preferences=await app.evaluate(({BrowserWindow})=>(BrowserWindow.getAllWindows()[0].webContents as unknown as {getLastWebPreferences:()=>Record<string,unknown>}).getLastWebPreferences());
 assert.equal(preferences.sandbox,true);assert.equal(preferences.contextIsolation,true);assert.equal(preferences.nodeIntegration,false);
 const status=await page.evaluate(()=>window.abyssusDesktop!.status());assert.equal(status.runtime,'container');
 if(process.platform==='linux')assert.equal(status.container?.available,true,JSON.stringify(status));
 await page.screenshot({path:path.join(out,`source-${process.platform}.png`)});
 writeFileSync(path.join(out,`source-${process.platform}.json`),JSON.stringify({platform:process.platform,source:JSON.parse(readFileSync(path.join(payload,'provenance.json'),'utf8')).source,privatePython:probe.stdout.trim(),nativeElectron:true,ownDependencyClosure:true,containerInventoryAvailable:status.container?.available,windowsDockerAcceptance:false,scope:'Actual exported source entry. No human picker, live provider or installed-package acceptance.'},null,2));
 await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});await app.close();
}catch(error){await app.evaluate(({app})=>app.exit(1)).catch(()=>{});throw error;}
console.log('PASS exported source runtime: actual native Electron, private Python imports, isolated renderer, selected desktop data, own dependency closure');
