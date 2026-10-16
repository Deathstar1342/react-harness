import {it,expect,afterEach} from 'vitest';
import {mkdtempSync,mkdirSync,lstatSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.js';
import {ProjectTransfers} from '../server/project-transfers.js';
import type {WorkerTransport} from '../server/worker-client.js';
import type {Runtime} from '../server/runtime.js';
import type {ToolService} from '../shared/types.js';
const cleanup:(()=>void)[]=[];
afterEach(()=>cleanup.splice(0).reverse().forEach(f=>f()));
function fixture(){
  const root=mkdtempSync(path.join(tmpdir(),'m30-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const store=new Store(path.join(root,'state.sqlite'));cleanup.push(()=>store.close());
  const folder=randomUUID(),workspace=path.join(root,'workspace');mkdirSync(workspace);mkdirSync(path.join(workspace,folder));
  const info=lstatSync(path.join(workspace,folder)),storageId=randomUUID(),sessionId=randomUUID();
  const receipt={id:randomUUID(),kind:'import',project:folder,phase:'succeeded',code:'COMPLETE',residue:false,manifestDigest:'a'.repeat(64),files:1,bytes:4,excludedCount:0,excluded:[],history:false,storageId,sessionId,identity:[info.dev,info.ino]};
  const calls:string[]=[];
  const client:WorkerTransport={storageId,sessionId,request:async(op)=>{calls.push(op);return receipt;}};
  const service=new ProjectTransfers(store,{} as Runtime,{} as ToolService,async()=>client,workspace);
  return {root,store,receipt,client,calls,service,workspace};
}
it('registers only an exact complete managed identity, consumes once, and persists project/chat identity',async()=>{
  const f=fixture(),code='b'.repeat(64);
  const result=await f.service.import('Copied',code,new AbortController().signal);
  const chat=f.store.createChat(result.project.id,'Retained','balanced');
  expect(f.calls).toEqual(['transfer_begin','transfer_receipt']);
  expect(result.project.path).toBe(path.join(f.workspace,f.receipt.project));
  await expect(f.service.import('Replay',code,new AbortController().signal)).rejects.toThrow('already consumed');
  expect(f.store.projects()).toHaveLength(1);expect(f.store.chat(chat.id).projectId).toBe(result.project.id);
});
it('refuses incomplete, mismatched and cancelled imports without registration or retry',async()=>{
  for(const fault of ['failed','identity','cancelled']){
    const f=fixture(),abort=new AbortController();
    if(fault==='failed')f.receipt.phase='failed';
    if(fault==='identity')f.receipt.identity=[0,0];
    if(fault==='cancelled')abort.abort();
    await expect(f.service.import('Copy','c'.repeat(64),abort.signal)).rejects.toThrow();
    expect(f.store.projects()).toHaveLength(0);
    await expect(f.service.import('Retry','c'.repeat(64),new AbortController().signal)).rejects.toThrow('already consumed');
  }
});
it('lost receipt and registration COMMIT failure leave a complete unregistered copy',async()=>{
  const f=fixture();f.client.request=async op=>{if(op==='transfer_receipt')throw Error('lost receipt');return f.receipt;};
  await expect(f.service.import('Copy','d'.repeat(64),new AbortController().signal)).rejects.toThrow('lost receipt');
  expect(f.store.projects()).toHaveLength(0);expect(lstatSync(path.join(f.workspace,f.receipt.project)).isDirectory()).toBe(true);
  const g=fixture();g.store.transaction=()=>{throw Error('COMMIT failed');};
  await expect(g.service.import('Copy','e'.repeat(64),new AbortController().signal)).rejects.toThrow('COMMIT failed');
  expect(g.store.projects()).toHaveLength(0);
});
it('holds both export reservations and retains quarantine on transport uncertainty',async()=>{
  const f=fixture();const project=f.store.createProject('Export',path.join(f.workspace,f.receipt.project));
  let runtimeHeld=false,toolsHeld=false;
  const runtime={exclusiveRemoval:async(_id:string,op:()=>Promise<unknown>)=>{runtimeHeld=true;try{return await op();}finally{runtimeHeld=false;}}} as Runtime;
  const tools={removeScope:async(_root:string,_chat:unknown,op:()=>unknown)=>{toolsHeld=true;try{return await op();}finally{toolsHeld=false;}}} as unknown as ToolService;
  f.client.request=async()=>{expect(runtimeHeld&&toolsHeld).toBe(true);throw Error('lost begin');};
  const service=new ProjectTransfers(f.store,runtime,tools,async()=>f.client,f.workspace);
  await expect(service.export(project.id,'f'.repeat(64),new AbortController().signal)).rejects.toThrow('lost begin');
  expect(f.store.project(project.id).removalError).toContain('uncertain');
});
