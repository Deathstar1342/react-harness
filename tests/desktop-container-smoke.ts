import { _electron as electron,expect } from '@playwright/test';
import { mkdtempSync,mkdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const root=path.resolve(import.meta.dirname,'..'),out=process.env.M31_RECEIPTS,appRoot=process.env.M31_APP_ROOT;
if(!out||!appRoot)throw new Error('Explicit external staging/receipt paths required');
mkdirSync(out,{recursive:true});const home=mkdtempSync(path.join(tmpdir(),'m31-electron-'));
const app=await electron.launch({args:[path.join(root,'tests/desktop-container-entry.cjs')],cwd:tmpdir(),chromiumSandbox:true,env:{...process.env,M31_APP_ROOT:appRoot,M31_SMOKE_HOME:home},timeout:30000});
try {
 const page=await app.firstWindow();await expect(page.getByRole('heading',{name:'Open your workspace'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Choose storage folder'})).toBeVisible();
 assert.equal(await page.evaluate(()=>typeof (globalThis as Record<string,unknown>).require),'undefined');
 const prefs=await app.evaluate(({BrowserWindow})=>(BrowserWindow.getAllWindows()[0].webContents as unknown as {getLastWebPreferences:()=>Record<string,unknown>}).getLastWebPreferences());
 assert.equal(prefs.sandbox,true);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);
 const state=await page.evaluate(()=>window.abyssusDesktop!.status());assert.equal(state.runtime,'container');assert(!JSON.stringify(state).includes('token'));
 await expect(page.getByText('Persistent profile home (Linux path)',{exact:true})).toHaveCount(0);await expect(page.getByText('Enable helper',{exact:true})).toHaveCount(0);
 const external=await page.evaluate(async()=>{try{await fetch('https://example.com');return true;}catch{return false;}});assert.equal(external,false);
 // Only native dialog return is synthetic; the actual main-process path checks and renderer are exercised.
 const selected=path.join(home,'selected-storage');mkdirSync(selected);
 await app.evaluate(({dialog},selected)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[selected]});},selected);
 await page.getByRole('button',{name:'Choose storage folder'}).click();await expect(page.getByText(selected,{exact:true})).toBeVisible();
 const second=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'tests/desktop-container-entry.cjs')],{cwd:tmpdir(),env:{...process.env,M31_APP_ROOT:appRoot,M31_SMOKE_HOME:home},windowsHide:true,stdio:'ignore'});
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{second.kill();reject(new Error('Second instance failed to exit'));},15000);second.once('error',error=>{clearTimeout(timer);reject(error);});second.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('Second instance exit failed'));});});
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),1);
 await page.screenshot({path:path.join(out,`m31-container-${process.platform}.png`)});
 console.log('PASS actual Electron container onboarding/isolation/native picker handoff; dialog return and packaged flag synthetic; actual single-instance lock; no Docker/package acceptance');
 await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
 await app.close();
}catch(error){await app.evaluate(({app})=>app.exit(1)).catch(()=>{});throw error;}
