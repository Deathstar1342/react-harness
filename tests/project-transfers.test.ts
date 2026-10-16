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
  const info=lstatSync(path.join(workspace,folder),{bigint:true}),storageId=randomUUID(),sessionId=randomUUID();
  const receipt={id:randomUUID(),kind:'import',project:folder,phase:'succeeded',code:'COMPLETE',residue:false,manifestDigest:'a'.repeat(64),files:1,bytes:4,excludedCount:0,excluded:[],history:false,storageId,sessionId,identity:[info.dev.toString(),info.ino.toString()]};
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
    if(fault==='identity')f.receipt.identity=['0','0'];
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
  const g=fixture();const original=g.store.db.exec.bind(g.store.db);let commitFailed=false;
  g.store.db.exec=(sql:string)=>{if(sql==='COMMIT'){commitFailed=true;throw Error('COMMIT failed');}return original(sql);};
  await expect(g.service.import('Copy','e'.repeat(64),new AbortController().signal)).rejects.toThrow('COMMIT failed');
  expect(commitFailed).toBe(true);expect(g.store.projects()).toHaveLength(0);
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

it('concurrent same-code imports cannot create duplicate registrations',async()=>{
  const f=fixture(),code='1'.repeat(64);
  const results=await Promise.allSettled([f.service.import('First',code,new AbortController().signal),f.service.import('Second',code,new AbortController().signal)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(f.store.projects()).toHaveLength(1);
  expect(f.calls.filter(op=>op==='transfer_receipt')).toHaveLength(1);
});
it('changed immutable observations or final receipts cannot redirect registration',async()=>{
  for(const field of ['id','manifestDigest','kind','phase','project']){
    const f=fixture();f.client.request=async op=>op==='transfer_receipt'?{...f.receipt,[field]:field==='kind'?'export':field==='phase'?'failed':field==='manifestDigest'?'0'.repeat(64):randomUUID()}:f.receipt;
    await expect(f.service.import('Copy','2'.repeat(64),new AbortController().signal)).rejects.toThrow();expect(f.store.projects()).toHaveLength(0);
  }
});

it('real Runtime and WorkspaceTools hold dirty-editor and mutation barriers throughout export',async()=>{
  const {Runtime}=await import('../server/runtime.js');
  const {WorkspaceTools}=await import('../server/tools/index.js');
  const {readConfig}=await import('../server/config.js');
  const {roleInstructions}=await import('../server/prompts.js');
  const f=fixture(),root=path.join(f.workspace,f.receipt.project),home=path.join(f.root,'home');mkdirSync(home);
  const project=f.store.createProject('Actual reservations',root),chat=f.store.createChat(project.id,'Paused work','balanced');
  const tools=new WorkspaceTools();tools.configureSandbox({home,protectedPaths:[],projects:()=>[root]});
  const config=readConfig({HARNESS_HOME:home,HARNESS_DATA_DIR:path.join(home,'data')});
  const runtime=new Runtime(f.store,{models:async()=>[],complete:async()=>{throw Error('provider must not run');}},tools,config,{instructions:roleInstructions});
  const service=new ProjectTransfers(f.store,runtime,tools,async()=>f.client,f.workspace);
  const receipt={...f.receipt,kind:'export',phase:'copying'};
  let started!:()=>void;const admitted=new Promise<void>(resolve=>{started=resolve;});
  let finish!:()=>void;const gate=new Promise<void>(resolve=>{finish=resolve;});
  f.client.request=async op=>{if(op==='transfer_begin'){started();return receipt;}await gate;return {...receipt,phase:'succeeded'};};
  try {
    tools.setDirty(root,'file.txt','editor',true);
    await expect(service.export(project.id,'3'.repeat(64),new AbortController().signal)).rejects.toThrow(/edit|buffer|dirty/i);
    tools.setDirty(root,'file.txt','editor',false);
    const exporting=service.export(project.id,'3'.repeat(64),new AbortController().signal);
    await admitted;
    await expect(tools.save(root,'blocked.txt','no write',null,'another-editor')).rejects.toThrow(/pending|mutation/i);
    expect(()=>tools.setDirty(root,'file.txt','new-editor',true)).toThrow(/pending/i);
    await expect(runtime.submit(chat.id,'Start work')).rejects.toThrow(/pending|uncertain|recovery|progress/i);
    finish();expect((await exporting).phase).toBe('succeeded');
    expect(f.store.project(project.id).removalError).toBe('');
    await tools.save(root,'after.txt','released only after terminal receipt',null,'editor');
  }finally{finish?.();await runtime.close();await tools.dispose();}
});

it('durable export quarantine blocks removal/reset and survives lost release reply and COMMIT',async()=>{
  const {Runtime}=await import('../server/runtime.js'),{WorkspaceTools}=await import('../server/tools/index.js'),{readConfig}=await import('../server/config.js'),{roleInstructions}=await import('../server/prompts.js');
  const f=fixture(),root=path.join(f.workspace,f.receipt.project),home=path.join(f.root,'home');mkdirSync(home);
  const project=f.store.createProject('Quarantined',root),tools=new WorkspaceTools();tools.configureSandbox({home,protectedPaths:[],projects:()=>[root]});
  const runtime=new Runtime(f.store,{models:async()=>[],complete:async()=>{throw Error('no provider');}},tools,readConfig({HARNESS_HOME:home,HARNESS_DATA_DIR:path.join(home,'data')}),{instructions:roleInstructions});
  const service=new ProjectTransfers(f.store,runtime,tools,async()=>f.client,f.workspace),code='4'.repeat(64);
  f.client.request=async()=>{throw Error('lost begin');};
  const original=f.store.db.exec.bind(f.store.db);
  try {
    await expect(service.export(project.id,code,new AbortController().signal)).rejects.toThrow('lost begin');
    await expect(runtime.exclusiveRemoval(project.id,async()=>{})).rejects.toThrow('export reservation');
    await expect(service.export(project.id,'5'.repeat(64),new AbortController().signal)).rejects.toThrow('export reservation');
    await expect(service.release(project.id,'5'.repeat(64))).rejects.toThrow('does not own');
    await expect(service.release(project.id,code)).rejects.toThrow('lost begin');
    expect(f.store.getState(`transfer:reservation:${project.id}`,null)).not.toBeNull();
    let calls=0;
    f.client.request=async(op,body)=>{calls++;expect(op).toBe('transfer_release');expect(body).toMatchObject({sessionId:f.client.sessionId,project:f.receipt.project,transferId:null,manifestDigest:null});return {released:true,receipt:null};};
    f.store.db.exec=(sql:string)=>{if(sql==='COMMIT')throw Error('release COMMIT failed');return original(sql);};
    await expect(service.release(project.id,code)).rejects.toThrow('release COMMIT failed');
    expect(f.store.getState(`transfer:reservation:${project.id}`,null)).not.toBeNull();
    f.store.db.exec=original;
    expect(await service.release(project.id,code)).toEqual({released:true,receipt:null});expect(calls).toBe(2);
    expect(f.store.getState(`transfer:reservation:${project.id}`,null)).toBeNull();
    await runtime.exclusiveRemoval(project.id,async()=>{});
  }finally{f.store.db.exec=original;await runtime.close();await tools.dispose();}
});

it('preserves device/inode values above 2^53 in receipts and refuses mismatched full-width identities',async()=>{
  const f=fixture();f.receipt.identity=['9007199254740993','18446744073709551615'];
  await expect(f.service.import('Full-width identity','6'.repeat(64),new AbortController().signal)).rejects.toThrow('Managed copy identity changed');
  const record=f.store.db.prepare("SELECT data FROM state WHERE key LIKE 'transfer:%'").get();
  expect(JSON.parse(String(record!.data)).receipt.identity).toEqual(['9007199254740993','18446744073709551615']);
  expect(f.store.projects()).toHaveLength(0);
});
