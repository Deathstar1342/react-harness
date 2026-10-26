import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.js';
import {WorkspaceTools} from '../server/tools/index.js';
import {ProcessJobs,processRecords} from '../server/process-jobs.js';
import {Previews} from '../server/previews.js';
import {nativeReply} from './native-fixture.js';
import type {RunState} from '../server/runtime.js';
import type {ToolResult} from '../shared/types.js';

it('bounds rich private projections across64 records/multiple assets and all128 max-response pages',async()=>{
 const base=await mkdtemp(path.join(tmpdir(),'m35-budget-')),root=path.join(base,'project');await mkdir(root);const store=new Store(path.join(base,'state.sqlite')),tools=new WorkspaceTools(),project=store.createProject('Budget fixture',root),chat=store.createChat(project.id,'Budget','autonomous');store.initializePlanning();
 const args={command:'controlled budget executor',previewPort:3001,timeoutMs:600000},call=nativeReply('start_process',args).toolCalls![0],binding={claimId:randomUUID(),binding:'a'.repeat(64),sessionId:randomUUID(),expiresAt:Date.now()+30000,identity:{storageId:randomUUID(),projectId:'b'.repeat(64),imageId:'sha256:'+'c'.repeat(64),layout:'d'.repeat(64)}};
 const state:RunState={generation:0,steps:0,steering:[],planOnly:false,instructionsHash:null,frames:[{id:'architect',role:'architect',messages:[{role:'assistant',content:'private rich transcript '.repeat(65000)}],repairs:0},{id:'coder',role:'coder',messages:[{role:'assistant',content:'',tool_calls:[call]}],repairs:0}]};store.setState('run:'+chat.id,state);store.setState(`native:frame:${chat.id}:coder`,state.frames[1].messages);
 let ready!:()=>void,finish!:(result:ToolResult)=>void;const started=new Promise<void>(resolve=>{ready=resolve;}),outcome=new Promise<ToolResult>(resolve=>{finish=resolve;});tools.execute=async context=>{context.beforeCommand?.(binding);ready();return outcome;};tools.closeCommandContext=async()=>{};const jobs=new ProcessJobs(store,tools),previews=new Previews(store,jobs,true);let pages=0;const body=Buffer.alloc(4*1024*1024,117),responseId=randomUUID();
 Reflect.set(previews,'connect',async()=>({sessionId:binding.sessionId,storageId:binding.identity.storageId,async request(op:string,input:any){if(op==='preview_open')return {handle:responseId,status:200,contentType:'text/javascript',totalBytes:body.length};if(op==='preview_read'){pages++;const chunk=body.subarray(input.offset,input.offset+32768);return {handle:responseId,offset:input.offset,nextOffset:input.offset+chunk.length,totalBytes:body.length,data:chunk.toString('base64')};}return {handle:responseId,closed:true};}}));
 try{
  const handle=jobs.start({projectId:project.id,chatId:chat.id,frameId:'coder',taskId:'architect',callId:call.id,commandId:randomUUID(),generation:0,modeVersion:0,instructionsHash:null,targets:[],approvalMode:'autonomous'},{name:'start_process',args}).data as {id:string};await started;
  const original=processRecords(store)[0];for(let index=0;index<63;index++){const id=randomUUID();store.setState('process-job:'+id,{...original,id,status:'completed',output:'x'.repeat(64000),action:{...original.action,args:{...args,command:'x'.repeat(64000)}}});}
  const t=performance.now(),catalog=previews.list(project.id),listMs=performance.now()-t;expect(catalog.entries).toHaveLength(64);
  const session=previews.open(project.id,handle.id),start=performance.now();const response=await previews.resource(project.id,session.id,'/max.js'),elapsed=performance.now()-start;
  expect(Buffer.from(response.body,'base64')).toEqual(body);expect(pages).toBe(128);expect(elapsed).toBeLessThan(25000);
  for(const asset of ['/main.js','/style.css'])expect((await previews.resource(project.id,session.id,asset)).status).toBe(200);
  const result={source:process.env.M35_SOURCE??'working tree',mode:'portable controlled transport + actual disk SQLite rich JSON duplicate scan; no native Docker latency proof',records:64,runBytes:Buffer.byteLength(JSON.stringify(state)),responseBytes:body.length,maxPages:128,totalPages:pages,listMs,maxResponseMs:elapsed,catalogBytes:Buffer.byteLength(JSON.stringify(catalog))};
  if(process.env.M35_BUDGET_RECEIPT)await writeFile(process.env.M35_BUDGET_RECEIPT,JSON.stringify(result,null,2));
 }finally{previews.shutdown();finish({ok:false,output:'Fixture finished',data:{cancelled:true}});await jobs.close();await tools.dispose();store.close();await rm(base,{recursive:true,force:true});}
},30000);
