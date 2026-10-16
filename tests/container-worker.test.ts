import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {ContainerShellPool} from '../server/container-shell.js';
import {workerCanonical,workerMac,type WorkerTransport} from '../server/worker-client.js';
import type {ToolContext} from '../shared/types.js';

function fixture(options:{veto?:boolean;cleanupLost?:boolean;activationLost?:boolean;wrongOffset?:boolean;cleanupWrong?:boolean;firstCloseLost?:boolean;resetWrong?:boolean}={}){
  const ops:string[]=[],sessionId=randomUUID(),storageId=randomUUID();let request:any,binding:any,authorized=false,closes=0;
  const transport:WorkerTransport={sessionId,storageId,async request(op,body:any){
    ops.push(op);
    if(op==='prepare'){request=body;return binding={claimId:body.claimId,binding:'a'.repeat(64),sessionId,expiresAt:Date.now()+30000,identity:{storageId,projectId:'b'.repeat(64),imageId:'sha256:'+'c'.repeat(64),layout:'d'.repeat(64)}};}
    if(op==='activate'){expect(authorized).toBe(true);expect(body).toEqual({claimId:binding.claimId,binding:binding.binding});if(options.activationLost)throw new Error('lost reply after acceptance');return {...body,state:'accepted'};}
    if(op==='cancel'){if(options.cleanupLost)throw new Error('cleanup unavailable');return {...body,cleanupConfirmed:true,beforeActivation:!ops.includes('activate')};}
    if(op==='observe'){return {...body,state:'finished',offset:options.wrongOffset?99:0,endOffset:2,totalBytes:2,output:Buffer.from('ok').toString('base64'),result:{exitCode:0,timedOut:false,truncated:false,shellReset:false,backgroundPids:[]}};}
    if(op==='close'){closes++;if(options.firstCloseLost&&closes===1)throw new Error('first cleanup lost');return {...body,contextId:options.cleanupWrong?'wrong':body.contextId,cleanupConfirmed:true};}
    if(op==='reset')return {...body,project:options.resetWrong?'wrong':body.project,reset:true,recipesRetained:true,reinstallRequiresNewApproval:true};
    throw new Error('unexpected op');
  }};
  const context:ToolContext={projectRoot:'/workspace/project',chatId:'chat',agentId:'agent',prepareCommand:async()=>{ops.push('fresh');if(options.veto)throw new Error('stale goal');},beforeCommand:token=>{expect(token).toEqual(binding);ops.push('commit');authorized=true;}};
  return {pool:new ContainerShellPool(async()=>transport),context,ops,getRequest:()=>request};
}
it('prepares infrastructure then checks freshness and authorizes the exact binding before activation',async()=>{
  const f=fixture();expect(await f.pool.run(f.context,'pwd')).toMatchObject({output:'ok',exitCode:0});
  expect(f.ops.slice(0,5)).toEqual(['prepare','fresh','commit','activate','observe']);
  expect(f.getRequest()).toMatchObject({project:'project',operation:{kind:'shell',command:'pwd'}});
  expect(f.getRequest()).not.toHaveProperty('hostPath');await f.pool.dispose();
});
it('only a trusted pre-activation veto with confirmed exact cleanup becomes not_started',async()=>{
  const f=fixture({veto:true});expect(await f.pool.run(f.context,'touch file')).toMatchObject({status:'not_started'});expect(f.ops).not.toContain('activate');
});
it('retains uncertainty when veto cleanup is lost',async()=>{
  const f=fixture({veto:true,cleanupLost:true});const result=await f.pool.run(f.context,'touch file');expect(result.status).toBeUndefined();expect(result.uncertain).toBe(true);await expect(f.pool.dispose()).rejects.toThrow(/uncertain/);
});
it('never retries activation after a lost reply, even when cancellation confirms cleanup',async()=>{
  const f=fixture({activationLost:true});const result=await f.pool.run(f.context,'touch file');expect(result.uncertain).toBe(true);expect(result.status).toBeUndefined();expect(f.ops.filter(x=>x==='activate')).toHaveLength(1);expect(f.ops).toContain('cancel');
});
it('rejects reordered output without publishing a forged completion',async()=>{
  const f=fixture({wrongOffset:true});expect(await f.pool.run(f.context,'pwd')).toMatchObject({uncertain:true});
});
it('binds the runtime authorization failure and confirms cleanup before no-effect evidence',async()=>{
  const f=fixture();f.context.beforeCommand=()=>{throw new Error('COMMIT failed');};expect(await f.pool.run(f.context,'touch file')).toMatchObject({status:'not_started'});expect(f.ops).not.toContain('activate');
});
it('uses the identical ASCII canonical signing definition and rejects ambiguous scalar values',()=>{
  expect(workerCanonical({z:'💡',a:'é'})).toBe('{"a":"\\u00e9","z":"\\ud83d\\udca1"}');
  expect(workerMac({hello:'é'},'a'.repeat(64))).toMatch(/^[a-f0-9]{64}$/);
  for(const input of [NaN,Infinity,1.5,9007199254740992,'\ud800'])expect(()=>workerCanonical(input)).toThrow();
});

it.each(['removeScope','dispose'] as const)('validates exact cleanup receipts in %s and retains failed ownership',async method=>{
  const f=fixture({cleanupWrong:true});await f.pool.run(f.context,'pwd');
  await expect(method==='removeScope'?f.pool.removeScope(f.context.projectRoot):f.pool.dispose()).rejects.toThrow(/uncertain/);
  await expect(f.pool.dispose()).rejects.toThrow(/uncertain/);expect(f.ops.filter(op=>op==='close')).toHaveLength(2);
});
it('dispose attempts all owned contexts after the first cleanup failure',async()=>{
  const f=fixture({firstCloseLost:true});await f.pool.run(f.context,'pwd');await f.pool.run({...f.context,agentId:'second'},'pwd');
  await expect(f.pool.dispose()).rejects.toThrow(/uncertain/);expect(f.ops.filter(op=>op==='close')).toHaveLength(2);
  await expect(f.pool.dispose()).rejects.toThrow(/uncertain/);expect(f.ops.filter(op=>op==='close')).toHaveLength(3);
});
it('reset rejects a successful reply for another project and quarantines ownership',async()=>{
  const f=fixture({resetWrong:true});await expect(f.pool.reset('/workspace/project')).rejects.toThrow(/uncertain/);
  expect(()=>f.pool.run(f.context,'pwd')).toThrow(/uncertain/);
});
