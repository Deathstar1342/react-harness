import { nativeReply } from './native-fixture.js';
// Disposable, real-backend M15 browser fixture. Synthetic provider; no live API requests.
// npm run build; node --import tsx tests/planning-browser-fixture.ts
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { WorkspaceTools } from '../server/tools/index.js';
import { Store } from '../server/store.js';
import { roleInstructions } from '../server/prompts.js';
const parent=await realpath(tmpdir()),root=await mkdtemp(path.join(parent,'rh-m15-browser-'));
const config=readConfig({PORT:'3185',STARK_BASE_URL:'http://127.0.0.1:1/synthetic-not-used',STARK_API_KEY:'synthetic-fixture-only',HARNESS_DATA_DIR:path.join(root,'data'),HARNESS_WORKSPACE_ROOT:path.join(root,'workspace')});
const store=new Store(path.join(config.dataDir,'state.sqlite'));
const directory=path.join(config.workspaceRoot,'fixture');await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'hello.txt'),'Disposable M15 fixture.\n');
const project=store.createProject('M15 disposable fixture',directory),chat=store.createChat(project.id,'Plan bridge fixture','review');
store.updateChat(chat.id,{mode:'plan',modeVersion:1});store.message(chat.id,'user','/plan Inspect the fixture file and verify its contents.');
const plan=store.revisePlan(chat.id,{phases:[{id:'inspect',title:'Inspect fixture',steps:[{id:'file',title:'Read hello.txt and independently review the result',status:'pending'}]}]});
for(let i=0;i<24;i++) store.message(chat.id,'architect',`Synthetic prior planning note ${i+1}. Header Plan must remain reachable at the end of a long transcript.`);
const replies=[
 nativeReply('delegate',{objective:'Inspect hello.txt',acceptanceCriteria:['Read fixture text and report it honestly'],paths:['hello.txt'],planStep:{planId:plan.id,planVersion:plan.version,phaseId:'inspect',stepId:'file'}}),
 nativeReply('read_file',{path:'hello.txt'}),
 nativeReply('submit_completion',{summary:'Observed fixture contents.'}),
 nativeReply('review_result',{verdict:'pass',findings:['Fixture read was recorded. No edit or live provider validation is claimed.']}),
 nativeReply('submit_completion',{summary:'Fixture inspection reviewed.'})
];
const {app}=await createApp({config,store,tools:new WorkspaceTools(),provider:{models:async()=>['synthetic-fixture'],complete:async()=>replies.shift()??nativeReply('submit_completion',{summary:'Synthetic planning response only.'})},hooks:{instructions:roleInstructions}});
await app.listen({host:'127.0.0.1',port:config.port});console.log(JSON.stringify({url:'http://127.0.0.1:3185',fixtureRoot:root,chatId:chat.id}));
let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await app.close();store.close();if(path.dirname(root)!==parent||!path.basename(root).startsWith('rh-m15-browser-'))throw new Error('Invalid fixture cleanup target');await rm(root,{recursive:true,force:true});process.exit(0);};
process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());process.stdin.resume();process.stdin.on('data',()=>void stop());setTimeout(()=>void stop(),30*60_000).unref();
