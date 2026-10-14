// Actual headless Chrome + HTTP/runtime/SQLite/file operations. Only model replies
// and the long-command executor are synthetic; Linux PTY evidence is separate.
import path from 'node:path';
import {mkdir,readFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {createApp} from '../server/app.js';
import {readConfig} from '../server/config.js';
import {roleInstructions} from '../server/prompts.js';
import {processRecords} from '../server/process-jobs.js';
import {orchestrationFixture,call,complete,pass,type Reply} from './orchestration-fixture.js';

const t=await orchestrationFixture();await t.seed();t.store.updateChat(t.chat.id,{approvalMode:'review'});
const execute=t.tools.execute.bind(t.tools);
t.tools.execute=async(context,action)=>{
  if(action.name!=='run_shell')return execute(context,action);
  try{await context.prepareCommand!();context.beforeCommand!();context.onOutput?.('Synthetic process ready; no host command is running.\n');}
  catch{return {ok:false,output:'Not started',data:{status:'not_started'}};}
  return new Promise(resolve=>{const stop=()=>resolve({ok:false,output:'Stopped synthetic command',data:{cancelled:true,shellReset:true}});context.signal?.addEventListener('abort',stop,{once:true});if(context.signal?.aborted)stop();});
};
t.tools.closeCommandContext=async()=>{};
const observe:Reply=()=>{const record=processRecords(t.store,undefined,t.chat.id)[0];if(record&&['starting','running'].includes(record.status)){t.replies.unshift(observe);return call('process_status',{processId:record.id,waitMs:1000});}return complete();};
t.replies.push(t.delegate(),call('start_process',{command:'synthetic-process-fixture',timeoutMs:600000}),observe,call('read_file',{path:'result.txt'}),pass(),{text:'Stopped process. Prior effects were not rolled back; the interrupted assignment remains unaccepted.',finishReason:'stop'});
const config=readConfig({PORT:'3188',STARK_BASE_URL:'http://127.0.0.1:1/synthetic',STARK_API_KEY:'synthetic-fixture',HARNESS_DATA_DIR:path.join(t.root,'data'),HARNESS_WORKSPACE_ROOT:path.join(t.root,'workspace')});
const {app}=await createApp({config,store:t.store,provider:t.provider,tools:t.tools,hooks:{instructions:roleInstructions}});
const address=await app.listen({host:'127.0.0.1',port:config.port}),browser=await chromium.launch({channel:'chrome',headless:true});
const receipts=process.env.M25_RECEIPTS??'test-results';await mkdir(receipts,{recursive:true});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(address);await page.getByRole('navigation',{name:'Conversations'}).getByRole('button',{name:'Scenario',exact:true}).click();
  const composer=page.getByRole('textbox',{name:'Message the architect'});
  await composer.fill('Start the controlled long-process fixture');await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(page.getByRole('button',{name:'Approve',exact:true})).toBeVisible();expect(processRecords(t.store)).toHaveLength(0);
  await page.getByRole('button',{name:'Approve',exact:true}).click();
  await page.getByRole('button',{name:'Terminal',exact:true}).click();
  await expect(page.getByRole('region',{name:'Command output'})).toContainText('Synthetic process ready');
  await page.screenshot({path:path.join(receipts,'m25-process-running.png'),fullPage:true});
  await page.getByRole('button',{name:'Stop process',exact:true}).click();
  await expect(page.getByRole('region',{name:'Command output'})).toContainText('Interrupted');
  await expect(page.getByText('Stopped process. Prior effects were not rolled back; the interrupted assignment remains unaccepted.',{exact:true})).toBeVisible();
  await page.screenshot({path:path.join(receipts,'m25-process-stopped.png'),fullPage:true});
  expect(t.store.plan(t.chat.id).phases[0].steps[0].status).toBe('blocked');
  await page.getByRole('button',{name:'Close terminal',exact:true}).click();
  const before=await t.tools.read(t.root,'result.txt');
  t.replies.push(t.delegate(1,{paths:['result.txt','renamed.txt']}),call('rename_file',{path:'result.txt',destination:'renamed.txt',baseHash:before.hash}),complete(),call('read_file',{path:'renamed.txt'}),pass(),{text:'File move recorded with both paths.',finishReason:'stop'});
  await composer.fill('Move the fixture file');await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(page.getByRole('button',{name:'Approve',exact:true})).toBeVisible();await page.getByRole('button',{name:'Approve',exact:true}).click();
  await expect(page.getByText('File move recorded with both paths.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Changes',exact:true}).first().click();
  await page.getByRole('button',{name:/result.txt → renamed.txt/}).click();
  await expect(page.getByRole('region',{name:'Recorded write preview'})).toContainText('/dev/null');
  await expect(page.getByRole('button',{name:'Undo this change',exact:true})).toBeEnabled();
  await page.screenshot({path:path.join(receipts,'m25-move-preview.png'),fullPage:true});
  await page.getByRole('button',{name:'Undo this change',exact:true}).click();
  await page.getByRole('button',{name:/result.txt → renamed.txt undone/}).click();
  await expect(page.getByRole('region',{name:'Recorded write preview'})).toContainText('undone');
  expect(await readFile(path.join(t.root,'result.txt'),'utf8')).toBe(before.content);expect((await t.tools.read(t.root,'renamed.txt')).hash).toBeNull();
  await page.screenshot({path:path.join(receipts,'m25-move-undone.png'),fullPage:true});
  if(errors.length)throw new Error(errors.join('\n'));
  console.log('PASS actual headless Chrome: approval before claim, owned process output/Stop/interrupted evidence, unaccepted plan, real two-path move preview and nullable-hash guarded undo. Synthetic model/process, actual HTTP/SQLite/files.');
}finally{await browser.close();await app.close();await t.close();}
