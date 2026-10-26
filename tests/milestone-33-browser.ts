// Real browser/Electron renderer + authenticated HTTP/disk SQLite. Synthetic
// retained restart evidence; no live provider, worker, package manager or host shell.
import path from 'node:path';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {chromium,_electron,expect,type Page} from '@playwright/test';
import {createApp} from '../server/app.js';
import {readConfig} from '../server/config.js';
import {Store} from '../server/store.js';
import {TransportAuth} from '../server/transport-auth.js';
import {nativeState} from './native-fixture.js';
import {createGoal} from '../server/goals.js';
import type {RunState} from '../server/runtime.js';
import type {ToolService,InstallRecord} from '../shared/types.js';

const receipts=process.env.M33_RECEIPTS;if(!receipts||!path.isAbsolute(receipts))throw new Error('Explicit external receipt root required');
await mkdir(receipts,{recursive:true});const root=await mkdtemp(path.join(tmpdir(),'m33-ui-')),projectRoot=path.join(root,'project');await mkdir(projectRoot);
const store=new Store(path.join(root,'state.sqlite')),project=store.createProject('Recovery fixture',projectRoot),chat=store.createChat(project.id,'Interrupted work','review'),other=store.createChat(project.id,'Other recovery chat','review');store.initializePlanning();
const human=store.message(chat.id,'user','Original human assignment retained privately');createGoal(store,chat.id,{objective:'Review retained work',acceptanceCriteria:['Keep uncertain effects blocked']},human.id);
const state=nativeState<RunState>({planOnly:false,steps:1,generation:1,steering:[],humanMessageIds:[human.id],frames:[{id:'original-coder',role:'coder',messages:[],repairs:0,pending:{id:'lost-dispatch',stage:'executing',action:{name:'run_shell',args:{command:'PRIVATE_COMMAND_SENTINEL'}}}}]});store.setState(`run:${chat.id}`,state);store.updateChat(chat.id,{status:'running'});
store.event(chat.id,'command',{agentId:'finished-coder',commandId:'finished-command',action:{name:'run_shell',args:{command:'completed fixture'}},status:'completed',exitCode:0});
const installId=randomUUID(),processId=randomUUID(),now=new Date().toISOString();
store.saveInstall({id:installId,projectId:project.id,chatId:chat.id,frameId:'install-frame',role:'architect',generation:1,modeVersion:0,recommendation:{packages:[{name:'hello'}],reason:'Retained fixture dependency'},settings:{policy:'ask',reviewerModel:'fixture',revision:0},state:'uncertain',createdAt:Date.now(),updatedAt:Date.now(),code:'LOST_REPLY',recoveryRequired:true} satisfies InstallRecord);store.event(chat.id,'install',{id:installId,state:'uncertain'});
store.setState(`process-job:${processId}`,{id:processId,projectId:project.id,chatId:chat.id,frameId:'process-frame',callId:'process-call',commandId:'process-command',generation:1,modeVersion:0,instructionsHash:null,targets:[],taskId:'original-root',approvalMode:'review',action:{name:'start_process',args:{command:'synthetic process'}},status:'running',createdAt:now,updatedAt:now,output:'',baseOffset:0,endOffset:0,truncated:false,outputEvents:0,dispatched:true});
store.revisePlan(chat.id,{phases:[{id:'phase',title:'Retained work',steps:[{id:'step',title:'Review evidence',status:'pending'}]}]});
let effects=0;const tools:ToolService={inspect:async()=>{effects++;throw new Error('No inspection expected');},execute:async()=>{effects++;throw new Error('No execution expected');},read:async(_root,path)=>({path,content:'',hash:null}),list:async()=>[],save:async()=>{effects++;throw new Error('No writes expected');},setDirty:()=>{},dispose:async()=>{}};
const auth=new TransportAuth('m33-ui'),config=readConfig({HARNESS_DATA_DIR:path.join(root,'data'),HARNESS_WORKSPACE_ROOT:path.join(root,'workspace'),STARK_BASE_URL:'http://127.0.0.1:1/private-endpoint',STARK_API_KEY:'PRIVATE_PROVIDER_SENTINEL'});
const {app}=await createApp({config,store,tools,transportAuth:auth,provider:{models:async()=>[],complete:async()=>{effects++;throw new Error('Opening recovery must never invoke a provider');}},hooks:{instructions:()=>''}});
const mutations:string[]=[];app.addHook('onRequest',async request=>{if(request.method!=='GET'&&!request.url.startsWith('/api/auth/pair'))mutations.push(`${request.method} ${request.url}`);});
const address=await app.listen({host:'127.0.0.1',port:0});
config.port=Number(new URL(address).port); // Keep the existing Origin gate exact for the allocated fixture port.
const logical=()=>JSON.stringify(['chats','events','state','approvals','install_requests','messages'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
const before=logical();let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined,desktop:Awaited<ReturnType<typeof _electron.launch>>|undefined;
let activePage:Page|undefined;
try{
  let page:Page;
  if(process.env.M33_ELECTRON==='1'){
    const home=path.join(root,'electron');await mkdir(home);
    desktop=await _electron.launch({executablePath:process.env.M33_ELECTRON_EXE,args:[path.join(import.meta.dirname,'recovery-electron-entry.cjs')],cwd:root,chromiumSandbox:true,env:{...process.env,M33_ELECTRON_HOME:home,M33_URL:address},timeout:30000});page=await desktop.firstWindow();
    const prefs=await desktop.evaluate(({BrowserWindow})=>(BrowserWindow.getAllWindows()[0].webContents as unknown as {getLastWebPreferences:()=>Record<string,unknown>}).getLastWebPreferences());expect(prefs.sandbox).toBe(true);expect(prefs.contextIsolation).toBe(true);expect(prefs.nodeIntegration).toBe(false);
    expect(await page.evaluate(()=>typeof (globalThis as Record<string,unknown>).require)).toBe('undefined');
  }else{browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});}
  activePage=page;const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(address);
  await page.evaluate(async({code})=>{const r=await fetch('/api/auth/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});if(!r.ok)throw new Error('Pairing failed');},{code:auth.pairingCode});await page.reload();
  const select=async(name:string)=>{await page.getByRole('navigation',{name:'Conversations'}).getByRole('button',{name:new RegExp('^'+name)}).click();};
  await select('Interrupted work');await expect(page.getByRole('button',{name:'Recovery',exact:true})).toBeVisible();expect(logical()).toBe(before);
  await page.getByRole('button',{name:'Recovery',exact:true}).click();let panel=page.getByRole('region',{name:'Recovery',exact:true});
  await expect(panel.getByText('Uncertain',{exact:true}).first()).toBeVisible();await expect(panel.getByText('Finished',{exact:true})).toBeVisible();await expect(panel).toContainText('Goal: blocked');await expect(panel).toContainText('Event #');
  expect(await panel.textContent()).not.toContain('PRIVATE_');await page.screenshot({path:path.join(receipts,`recovery-${desktop?'electron':'browser'}.png`)});
  await panel.getByRole('button',{name:'Refresh recovery',exact:true}).click();await expect(panel.getByRole('button',{name:'Refresh recovery',exact:true})).toBeEnabled();expect(logical()).toBe(before);expect(effects).toBe(0);expect(mutations).toEqual([]);
  store.updateChat(chat.id,{mode:'plan',modeVersion:3});await expect(panel.getByText(/This observation may be stale/)).toBeVisible();
  await panel.getByRole('button',{name:'Refresh recovery',exact:true}).click();await expect(panel).toContainText('plan mode · version 3');
  await panel.getByRole('button',{name:'Review Resume / pause controls',exact:true}).click();await expect(page.getByRole('button',{name:'Resume',exact:true})).toBeVisible();expect(effects).toBe(0);expect(mutations).toEqual([]);
  await page.getByRole('button',{name:'Recovery',exact:true}).click();panel=page.getByRole('region',{name:'Recovery',exact:true});await panel.getByRole('button',{name:'Open command evidence',exact:true}).first().click();await expect(page.getByRole('region',{name:'Command output'})).toBeVisible();expect(effects).toBe(0);expect(mutations).toEqual([]);
  await page.getByRole('button',{name:'Close terminal'}).click();await page.getByRole('button',{name:'Recovery',exact:true}).click();panel=page.getByRole('region',{name:'Recovery',exact:true});await panel.getByRole('button',{name:'Review goal and original assignment'}).click();await expect(page.getByRole('region',{name:'Current plan'})).toBeVisible();expect(effects).toBe(0);expect(mutations).toEqual([]);
  await page.getByRole('button',{name:'Close plan'}).click();
  const priorNavigation=logical();await page.getByRole('button',{name:'Recovery',exact:true}).click();panel=page.getByRole('region',{name:'Recovery',exact:true});await panel.getByRole('button',{name:'Open install recovery',exact:true}).click();
  expect(await page.locator('#recovery-install-history').evaluate((element:HTMLDetailsElement)=>element.open)).toBe(false);expect(logical()).toBe(priorNavigation);expect(effects).toBe(0);expect(mutations).toEqual([]);
  await page.getByText('System install history',{exact:true}).click();await expect(page.getByRole('article',{name:'Selected install recovery'})).toContainText(installId);await expect(page.getByRole('button',{name:'Reconcile installed state',exact:true})).toBeVisible();expect(effects).toBe(0);expect(mutations).toEqual([]);
  await page.getByText('System install history',{exact:true}).click();
  // Hold a recovery request, switch chats, then release the obsolete response.
  // Cleanup/AbortController must prevent the old observation from replacing new UI.
  let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  await page.route(`**/api/chats/${chat.id}/recovery`,async route=>{entered();await held;await route.continue().catch(()=>{});});
  await page.getByRole('button',{name:'Recovery',exact:true}).click();await started;await select('Other recovery chat');release();
  await page.getByRole('button',{name:'Recovery',exact:true}).click();panel=page.getByRole('region',{name:'Recovery',exact:true});await expect(panel).toContainText('No operation evidence');await expect(panel).not.toContainText('lost-dispatch');
  await page.reload();await select('Interrupted work');await page.getByRole('button',{name:'Recovery',exact:true}).click();await expect(page.getByRole('region',{name:'Recovery',exact:true})).toContainText('Goal: blocked');expect(effects).toBe(0);expect(mutations).toEqual([]);expect(errors).toEqual([]);
  await writeFile(path.join(receipts,`recovery-${desktop?'electron':'browser'}.json`),JSON.stringify({platform:process.platform,host:desktop?'real Electron sandboxed test host':'real Chrome',source:process.env.M33_SOURCE??'working tree',checks:['authenticated SQLite recovery render','uncertain/finished/blocked distinctions','owned process evidence','open/refresh/navigation no effects','stale mode refresh','existing controls focus','terminal and plan navigation','exact install navigation stays closed until deliberate expansion','old-chat response ignored','reload no auto-run'],effects,mutations,errors,fixtureRoot:root,limits:'Synthetic retained evidence and tool/provider boundaries; no Docker, worker, Linux/PTY, installed-device/human or live provider acceptance'},null,2));
  console.log(`PASS recovery ${desktop?'Electron':'browser'}: actual authenticated HTTP/disk SQLite, stale refresh and navigation, zero effects`);
}catch(error){if(activePage){await activePage.screenshot({path:path.join(receipts,`recovery-failure-${Date.now()}.png`)}).catch(()=>{});console.error((await activePage.locator('body').textContent())?.slice(0,5000));}throw error;}
finally{await desktop?.close();await browser?.close();await app.close();store.close();}
