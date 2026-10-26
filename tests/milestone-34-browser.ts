// Real authenticated HTTP + disk SQLite/guarded project files in Chrome or sandboxed Electron.
// Fixture provider; no worker, shell, Docker/device, installed-package, human or live-provider acceptance.
import path from 'node:path';
import {mkdir,mkdtemp,writeFile,readFile,rename,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {chromium,_electron,expect,type Page} from '@playwright/test';
import {Store} from '../server/store.js';
import {WorkspaceTools} from '../server/tools/index.js';
import {readConfig} from '../server/config.js';
import {createApp} from '../server/app.js';
import {TransportAuth} from '../server/transport-auth.js';
const receipts=process.env.M34_RECEIPTS;if(!receipts||!path.isAbsolute(receipts))throw new Error('Explicit external receipt root required');await mkdir(receipts,{recursive:true});
const base=await mkdtemp(path.join(await realpath(tmpdir()),'m34-ui-')),workspace=path.join(base,'workspace'),root=path.join(workspace,randomUUID()),home=path.join(base,'app');await mkdir(root,{recursive:true});await mkdir(home);
await writeFile(path.join(root,'a.ts'),'Original a\n');await writeFile(path.join(root,'b.ts'),'Original b\n');await writeFile(path.join(root,'.env'),'PRIVATE_CHECKPOINT_SENTINEL');await writeFile(path.join(root,'photo.png'),Buffer.from([0,255,0]));
const store=new Store(path.join(home,'state.sqlite')),tools=new WorkspaceTools(),project=store.createProject('Checkpoint fixture',root),chat=store.createChat(project.id,'Task boundary','review'),auth=new TransportAuth('m34-ui');let providerCalls=0;
const config=readConfig({HARNESS_HOME:home,HARNESS_DATA_DIR:path.join(home,'state'),HARNESS_WORKSPACE_ROOT:workspace,STARK_BASE_URL:'http://127.0.0.1:1/private-endpoint',STARK_API_KEY:'PRIVATE_PROVIDER_SENTINEL'});
const {app}=await createApp({config,store,tools,transportAuth:auth,provider:{models:async()=>[],complete:async()=>{providerCalls++;throw new Error('Checkpoints cannot invoke a provider');}},hooks:{instructions:()=>''}});
const address=await app.listen({host:'127.0.0.1',port:0});config.port=Number(new URL(address).port);
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined,desktop:Awaited<ReturnType<typeof _electron.launch>>|undefined,page:Page|undefined;
const host=process.env.M34_ELECTRON==='1'?'electron':'browser';
try{
 if(host==='electron'){
  const electronHome=path.join(base,'electron');await mkdir(electronHome);
  desktop=await _electron.launch({executablePath:process.env.M34_ELECTRON_EXE,args:[path.join(import.meta.dirname,'checkpoints-electron-entry.cjs')],cwd:base,chromiumSandbox:true,env:{...process.env,M34_ELECTRON_HOME:electronHome,M34_URL:address},timeout:30000});page=await desktop.firstWindow();
  const prefs=await desktop.evaluate(({BrowserWindow})=>(BrowserWindow.getAllWindows()[0].webContents as unknown as {getLastWebPreferences:()=>Record<string,unknown>}).getLastWebPreferences());expect(prefs.sandbox).toBe(true);expect(prefs.contextIsolation).toBe(true);expect(prefs.nodeIntegration).toBe(false);expect(await page.evaluate(()=>typeof (globalThis as Record<string,unknown>).require)).toBe('undefined');
 }else{browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});}
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(address);
 await page.evaluate(async code=>{const response=await fetch('/api/auth/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});if(!response.ok)throw new Error('Pairing failed');},auth.pairingCode);await page.reload();
 await page.getByRole('navigation',{name:'Conversations'}).getByRole('button',{name:/^Task boundary/}).click();
 const snapshots=()=>Number(store.db.prepare("SELECT count(*) AS n FROM state WHERE key LIKE 'checkpoint:v1:%'").get()!.n);
 const before=store.messages(chat.id);await page.getByRole('button',{name:'Checkpoints',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Checkpoints',exact:true});await expect(dialog.getByText('No checkpoints yet.')).toBeVisible();expect(snapshots()).toBe(0);expect(providerCalls).toBe(0);
 await dialog.getByLabel('Checkpoint label').fill('Before task changes');await dialog.getByRole('button',{name:'Capture checkpoint',exact:true}).click();await expect(dialog.getByRole('button',{name:/Before task changes/})).toBeVisible();expect(snapshots()).toBe(1);
 await writeFile(path.join(root,'a.ts'),'Changed a\n');await rename(path.join(root,'b.ts'),path.join(root,'moved.ts'));await writeFile(path.join(root,'added.ts'),'New file\n');
 // Refresh waits for the real filesystem watcher revision before requesting a fresh preview.
 await page.waitForTimeout(350);await dialog.getByRole('button',{name:'Refresh checkpoints',exact:true}).click();await dialog.getByRole('button',{name:/Before task changes/}).click();
 let review=dialog.getByRole('region',{name:'Checkpoint restore preview'}); // section is named via aria-label.
 await expect(review.getByText('4 file changes',{exact:false})).toBeVisible();await expect(review.getByRole('button',{name:'Restore reviewed files',exact:true})).toBeDisabled();expect(await dialog.textContent()).not.toContain('PRIVATE_CHECKPOINT_SENTINEL');expect(await dialog.textContent()).not.toContain('PRIVATE_PROVIDER_SENTINEL');
 await page.screenshot({path:path.join(receipts,`checkpoint-${host}-preview.png`)});
 await review.getByLabel('Restore this reviewed file set').check();await review.getByRole('button',{name:'Restore reviewed files',exact:true}).click();await expect(dialog.getByRole('button',{name:'Capture checkpoint',exact:true})).toBeEnabled();
 expect(await readFile(path.join(root,'a.ts'),'utf8')).toBe('Original a\n');expect(await readFile(path.join(root,'b.ts'),'utf8')).toBe('Original b\n');await expect(readFile(path.join(root,'moved.ts'))).rejects.toMatchObject({code:'ENOENT'});await expect(readFile(path.join(root,'added.ts'))).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(path.join(root,'.env'),'utf8')).toBe('PRIVATE_CHECKPOINT_SENTINEL');
 await dialog.getByText('File restore history',{exact:true}).click();await expect(dialog.getByText('done',{exact:true})).toBeVisible();expect(store.fileChanges(project.id)).toHaveLength(4);expect(store.messages(chat.id)).toEqual(before);expect(providerCalls).toBe(0);
 await page.screenshot({path:path.join(receipts,`checkpoint-${host}-restored.png`)});
 // Backend stale token protection after an exact fresh preview, exercised through authenticated browser fetch.
 const checkpointId=String(store.db.prepare("SELECT json_extract(data,'$.id') AS id FROM state WHERE key LIKE 'checkpoint:v1:%'").get()!.id);
 const stale=await page.evaluate(async({projectId,checkpointId,chatId})=>{const r=await fetch(`/api/projects/${projectId}/checkpoints/${checkpointId}/preview`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chatId})});if(!r.ok)throw new Error(await r.text());return r.json();},{projectId:project.id,checkpointId,chatId:chat.id});
 await writeFile(path.join(root,'a.ts'),'Later human edit\n');const rejected=await page.evaluate(async({projectId,checkpointId,chatId,preview})=>{const r=await fetch(`/api/projects/${projectId}/checkpoints/${checkpointId}/restore`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chatId,previewToken:preview.previewToken,revision:preview.revision,confirmation:'restore-files'})});return {status:r.status,body:await r.text()};},{projectId:project.id,checkpointId,chatId:chat.id,preview:stale});expect(rejected.status).toBe(409);expect(await readFile(path.join(root,'a.ts'),'utf8')).toBe('Later human edit\n');
 await page.reload();await page.getByRole('navigation',{name:'Conversations'}).getByRole('button',{name:/^Task boundary/}).click();await page.getByRole('button',{name:'Checkpoints',exact:true}).click();await expect(page.getByRole('dialog',{name:'Checkpoints'}).getByRole('button',{name:/Before task changes/})).toBeVisible();expect(snapshots()).toBe(1);expect(providerCalls).toBe(0);expect(errors).toEqual([]);
 await writeFile(path.join(receipts,`checkpoint-${host}.json`),JSON.stringify({source:process.env.M34_SOURCE??'working tree',platform:process.platform,host:desktop?'actual sandboxed Electron test host':'actual headless Chrome',checks:['authenticated capture/list','opening and reload no capture or provider execution','explicit full multi-file preview and checkbox','actual add/delete/move/multifile restore','Git/private/binary exclusions','normal append-only file history','stale preview preserves later edit','reload preserves capture/history and never replays'],providerCalls,errors,staleStatus:rejected.status,fixtureRoot:base,limits:'Fixture provider and portable controller filesystem; no Docker/owned worker/Linux PTY/installed-device/native-human/live-provider/package acceptance'},null,2));
 console.log(`PASS M34 ${host}: actual authenticated capture/multifile preview/explicit restore, stale edit preserved, provider calls ${providerCalls}`);
}catch(error){if(page)await page.screenshot({path:path.join(receipts,`checkpoint-${host}-failed.png`)}).catch(()=>{});throw error;}
finally{await desktop?.close();await browser?.close();await app.close();store.close();}
