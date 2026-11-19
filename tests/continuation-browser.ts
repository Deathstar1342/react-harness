// Browser, real SQLite, and scoped reads with a controlled provider.
import path from 'node:path';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {chromium,expect,type Page} from '@playwright/test';
import {createApp} from '../server/app.js';
import {readConfig} from '../server/config.js';
import {createManagedHooks} from '../server/context.js';
import {WorkspaceTools} from '../server/tools/index.js';
import {Store} from '../server/store.js';
import {TransportAuth} from '../server/transport-auth.js';
import type {CompletionResult,ModelProvider} from '../shared/types.js';
import {nativeReply} from './native-fixture.js';

const receipts=process.env.CONTINUATION_RECEIPTS;
if (!receipts || !path.isAbsolute(receipts)) throw Error('Explicit receipt directory required');
await mkdir(receipts,{recursive:true});
const home=await mkdtemp(path.join(tmpdir(),'continuation-browser-'));
const root=path.join(home,'project');
await mkdir(root);
await writeFile(path.join(root,'entry.ts'),'export function observed() { return "CONTINUATION_SOURCE"; }\n');
const store=new Store(path.join(home,'state.sqlite'));
const project=store.createProject('Continuation project',root);
const chat=store.createChat(project.id,'Scoped interruption','review');
const read=nativeReply('read_file',{path:'entry.ts'});
const plan=nativeReply('set_plan',{
  phases:[{id:'phase',title:'Implementation',steps:[{id:'step',title:'Constrain the change',status:'pending'}]}],
  admission:[{phaseId:'phase',stepId:'step',task:{objective:'Preserve behavior'},sources:[{path:'entry.ts',callId:read.toolCalls![0].id,symbol:'observed'}],
    newFiles:[],checks:[{method:'inspection',target:'entry.ts',expected:'Same behavior'}]}],
});
const prose:CompletionResult={text:'Historical work remains.',finishReason:'stop'};
const replies:Array<CompletionResult|(()=>CompletionResult)>=[read,plan,()=>{
  const current=store.plan(chat.id);
  return nativeReply('delegate',{objective:'Inspect the assigned source',acceptanceCriteria:['Verify current behavior'],paths:['entry.ts'],
    planStep:{planId:current.id,planVersion:current.version,phaseId:'phase',stepId:'step'}});
},nativeReply('read_file',{path:'entry.ts'}),prose,prose,prose];
const calls:Parameters<ModelProvider['complete']>[0][]=[];
const provider:ModelProvider={models:async()=>[],complete:async input=>{
  calls.push(input);
  const reply=replies.shift();
  if(!reply)throw Error('Unexpected provider call');
  return typeof reply==='function'?reply():reply;
}};
const config=readConfig({HARNESS_HOME:path.join(home,'app'),HARNESS_DATA_DIR:path.join(home,'app','data'),HARNESS_WORKSPACE_ROOT:home,
  STARK_BASE_URL:'http://127.0.0.1:1',STARK_API_KEY:'controlled-fixture',CODER_INPUT_TOKEN_LIMIT:'48000',
  MODEL_MAX_OUTPUT_TOKENS:'256',TOKENS_PER_MINUTE:'2000000'});
const auth=new TransportAuth('continuation-ui');
const tools=new WorkspaceTools();
const {app,runtime}=await createApp({config,store,provider,tools,hooks:createManagedHooks(provider,store,config),transportAuth:auth});
let page:Page|undefined;
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
const errors:string[]=[];
const host='chrome';
const snapshot=()=>JSON.stringify(['chats','events','state','approvals','task_queues','queue_links','inspector_requests'].map(table=>
  store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
try {
  await runtime.submit(chat.id,'Inspect the assigned source and keep existing behavior.');
  await runtime.wait(chat.id);
  expect(store.chat(chat.id).status).toBe('paused');
  const before=snapshot(), count=calls.length;
  const address=await app.listen({host:'127.0.0.1',port:0});
  config.port=Number(new URL(address).port);

    browser=await chromium.launch({channel:'chrome',headless:true});
    page=await browser.newPage({viewport:{width:1440,height:1000}});

  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(address);
  await page.evaluate(async code=>{
    const response=await fetch('/api/auth/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
    if(!response.ok)throw Error('Pairing failed');
  },auth.pairingCode);
  await page.reload();
  await page.getByRole('navigation',{name:'Conversations'}).getByRole('button',{name:/^Scoped interruption/}).click();
  await page.getByRole('button',{name:'Resume',exact:true}).click();
  const panel=page.getByRole('region',{name:'Recovery',exact:true});
  const resume=panel.getByRole('button',{name:'Resume this assignment',exact:true});
  await expect(resume).toBeEnabled();
  await expect(panel).toContainText('Inspect the assigned source');
  expect(await panel.textContent()).not.toContain('CONTINUATION_SOURCE');
  expect(calls).toHaveLength(count);
  expect(snapshot()).toBe(before);
  const rejected=await page.evaluate(async chatId=>{
    const url='/api/chats/'+chatId+'/control';
    const method='POST',headers={'Content-Type':'application/json'};
    const malformed=await fetch(url,{method,headers,body:JSON.stringify({action:'resume',precondition:'invalid'})});
    const omitted=await fetch(url,{method,headers,body:JSON.stringify({action:'resume'})});
    return [malformed.status,omitted.status];
  },chat.id);
  expect(rejected).toEqual([400,409]);
  expect(snapshot()).toBe(before);
  await runtime.control(chat.id,'pause');
  await expect(resume).toBeDisabled();
  await panel.getByRole('button',{name:'Refresh recovery',exact:true}).click();
  await expect(resume).toBeEnabled();
  const screenshot=path.join(receipts,`continuation-${host}.png`);
  await page.screenshot({path:screenshot});
  replies.push(nativeReply('read_file',{path:'entry.ts'}),prose,prose,prose);
  const accepted=page.waitForResponse(response=>response.url().endsWith('/control')&&response.request().method()==='POST');
  await resume.click();
  expect((await accepted).status()).toBe(200);
  await runtime.wait(chat.id);
  expect(calls).toHaveLength(count+4);
  expect(calls[count].messages.find(message=>message.content.startsWith('Advisory Coder context.'))?.content).toContain('CONTINUATION_SOURCE');
  expect(calls.slice(count).some(input=>input.messages[0].content.startsWith('Write a factual continuation'))).toBe(false);
  expect(errors).toEqual([]);
  await writeFile(path.join(receipts,`continuation-${host}.json`),JSON.stringify({
    source:process.env.CONTINUATION_SOURCE??'working tree',host,platform:process.platform,providerCallsBefore:count,
    providerCallsAfter:calls.length,openAndRefreshEffects:0,explicitControlStatus:200,staleViewDisabled:true,errors,
  },null,2));
  console.log(`PASS ${host} checked Coder Resume`);
} catch(error) {
  await page?.screenshot({path:path.join(receipts,`continuation-${host}-failure-${Date.now()}.png`)}).catch(()=>{});
  throw error;
} finally {
  await browser?.close();
  await app.close();
  store.close();
}
