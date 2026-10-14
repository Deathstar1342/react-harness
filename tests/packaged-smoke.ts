/** Actual production executable/entry. No smoke-entry.cjs substitutions. */
import { _electron as electron, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
const executable=process.argv[2];if(!executable)throw new Error('Provide an actual packaged executable');
const home=process.env.ABYSSUS_PACKAGE_TEST_HOME??mkdtempSync(path.join(tmpdir(),'abyssus-package-'));
mkdirSync(home,{recursive:true});
writeFileSync(path.join(home,'preserve.txt'),'package-preservation-fixture');
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
    assert(info.packaged);assert(info.sandbox);assert.equal(path.resolve(info.data).toLowerCase(),path.resolve(home).toLowerCase());
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
        assert.equal(await attempt(process.env.ABYSSUS_TEST_INSTALLER,['/S','/D='+other]),73);
        // An unrelated child exit cannot release the process-owned native lease.
        execFileSync(process.execPath,['-e','process.exit(0)']);
        const uninstall=readdirSync(path.dirname(executable)).find(n=>/^Uninstall.*\.exe$/.test(n));assert(uninstall);
        assert.equal(await attempt(path.join(path.dirname(executable),uninstall),['/S','_?='+path.dirname(path.resolve(executable))]),73);
        assert.equal(await page.getByRole('heading',{name:'Open your workspace'}).isVisible(),true);
        console.log('PASS process-owned maintenance refusal after unrelated child exit; second instance focuses existing app');
      }
    }
    if(process.platform==='linux'&&i===0){
      await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
      await page.getByLabel('Persistent profile home (Linux path)').fill(path.join(home,'linux-profile'));
      await page.getByLabel('Profile action').selectOption('initialize');
      await page.getByRole('button',{name:'Open profile',exact:true}).click();
      await expect(page.getByRole('heading',{name:'Optional system installs'})).toBeVisible({timeout:45000});
      const state=await page.evaluate(()=>window.abyssusDesktop!.status());assert.equal(state.phase,'ready');
      assert(state.checks?.slice(0,5).every(c=>c.ok));
      console.log('PASS installed Linux backend, SQLite/native PTY/runtime/sandbox checks');
    }
    await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
  } catch(error){console.error(error);throw error;}
  finally {await app.close();clearTimeout(deadline);}
}
console.log('PASS actual packaged production entry, isolated data directory, sandbox and restart');
