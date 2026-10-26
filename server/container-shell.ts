import {createHash,randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {z} from 'zod';
import type {ToolContext} from '../shared/types.js';
import type {CommandResult} from './tools/shell.js';
import {WorkerClient,preparedSchema,workerResultSchema,type WorkerTransport,type WorkerBinding} from './worker-client.js';
import {containerExecutionUnavailable} from './container-contract.js';
import {ToolError} from './tools/paths.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const claim=(binding:WorkerBinding)=>({claimId:binding.claimId,binding:binding.binding});
const observation=z.object({claimId:z.string().uuid(),binding:z.string(),state:z.enum(['prepared','accepted','running','finished','uncertain','cancelled','expired']),offset:z.number().int().nonnegative(),endOffset:z.number().int().nonnegative(),totalBytes:z.number().int().max(1000000),output:z.string().max(45000),result:workerResultSchema.nullable()}).strict();
export class ContainerShellPool {
  private transport?:Promise<WorkerTransport>;
  private contexts=new Map<string,{root:string;chatId:string;tail:Promise<unknown>;pending:number}>();
  private quarantined=new Set<string>();
  private disposed=false;
  constructor(private connect:()=>Promise<WorkerTransport>=()=>WorkerClient.connect()){}
  private client(){return this.transport??=this.connect();}
  private id(context:ToolContext){return hash(JSON.stringify([context.projectRoot,context.chatId,context.agentId]));}
  run(context:ToolContext,command:string,timeoutMs=30000,beforeRun?:()=>Promise<void>,afterRun?:(result:CommandResult)=>Promise<void>):Promise<CommandResult> {
    return this.execute(context,{kind:'shell',command,...(context.previewPort===undefined?{}:{previewPort:context.previewPort})},timeoutMs,1000000,beforeRun,afterRun);
  }
  git(context:ToolContext,args:string[],limit:number):Promise<CommandResult> {
    return this.execute(context,{kind:'git',args},15000,limit);
  }
  private execute(context:ToolContext,operation:unknown,timeoutMs:number,outputLimit:number,beforeRun?:()=>Promise<void>,afterRun?:(result:CommandResult)=>Promise<void>):Promise<CommandResult> {
    if(this.disposed||this.quarantined.has(context.projectRoot))throw new ToolError('Worker scope is closed or cleanup is uncertain.','WORKER_UNAVAILABLE');
    const id=this.id(context),entry=this.contexts.get(id)??{root:context.projectRoot,chatId:context.chatId,tail:Promise.resolve(),pending:0};
    if(entry.pending>=16||!this.contexts.has(id)&&this.contexts.size>=32)throw new ToolError('Worker queue/session limit reached.');
    this.contexts.set(id,entry);entry.pending++;
    const result=entry.tail.then(async()=>{
      let binding:WorkerBinding|undefined,activated=false,output='';
      let client:WorkerTransport;try{client=await this.client();}catch{this.contexts.delete(id);throw new ToolError(containerExecutionUnavailable,'CONTAINER_EXECUTION_UNAVAILABLE');}
      if(!/^\/workspace\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(context.projectRoot))throw new ToolError('Worker requires an exact managed project.');
      const request={claimId:randomUUID(),project:context.projectRoot.slice('/workspace/'.length),contextId:id,operation,timeoutMs:Math.min(timeoutMs,600000),outputLimit:Math.min(outputLimit,1000000)};
      try {
        binding=preparedSchema.parse(await client.request('prepare',request));
        if(binding.claimId!==request.claimId||binding.sessionId!==client.sessionId||binding.identity.storageId!==client.storageId)throw new Error('Worker preparation identity mismatch.');
        await beforeRun?.();
        try {
          if(this.disposed)throw new Error('Tool service closed before activation.');
          context.signal?.throwIfAborted();
          await context.prepareCommand?.();
          context.signal?.throwIfAborted();
          context.beforeCommand?.(binding);
        }catch(error){
          const cancelled=z.object({claimId:z.literal(binding.claimId),binding:z.literal(binding.binding),cleanupConfirmed:z.literal(true),beforeActivation:z.literal(true)}).strict().parse(await client.request('cancel',claim(binding)));
          if(!cancelled.cleanupConfirmed)throw new Error();
          return {status:'not_started' as const,output:'',error:error instanceof Error?error.message:'Runtime vetoed worker activation.'};
        }
        // The exact prepared binding was durably authorized above. No retry on a lost activation reply.
        activated=true;
        z.object({claimId:z.literal(binding.claimId),binding:z.literal(binding.binding),state:z.literal('accepted')}).strict().parse(await client.request('activate',claim(binding)));
        let offset=0,cancelSent=false,cancelFailed=false;const deadline=Date.now()+request.timeoutMs+60000;
        const decoder=new StringDecoder('utf8');
        for(;;){
          if(Date.now()>deadline)throw new Error('Worker observation deadline exceeded.');
          if(context.signal?.aborted&&!cancelSent){cancelSent=true;try{await client.request('cancel',claim(binding));}catch{cancelFailed=true;}}
          const state=observation.parse(await client.request('observe',{...claim(binding),offset}));
          if(state.claimId!==binding.claimId||state.binding!==binding.binding||state.offset!==offset)throw new Error('Worker observation binding mismatch.');
          const bytes=Buffer.from(state.output,'base64');
          if(bytes.toString('base64')!==state.output||state.endOffset!==offset+bytes.length||state.endOffset>state.totalBytes)throw new Error('Worker output sequence mismatch.');
          offset=state.endOffset;const chunk=decoder.write(bytes);output+=chunk;if(chunk)context.onOutput?.(chunk);
          if(state.state==='uncertain'||cancelFailed)throw new Error('Worker outcome or cleanup is uncertain.');
          if(state.state==='finished'&&offset===state.totalBytes){
            if(!state.result)throw new Error('Worker has no exit receipt.');
            const tail=decoder.end();output+=tail;if(tail)context.onOutput?.(tail);
            const outcome={output,...state.result,...(state.result.shellReset?{error:'Worker session state was lost; cwd/exported environment reset.'}:{})};
            await afterRun?.(outcome);return outcome;
          }
          if(!['accepted','running','finished'].includes(state.state))throw new Error('Worker claim has no terminal execution receipt.');
          await new Promise(resolve=>setTimeout(resolve,100));
        }
      }catch(error){
        if(binding)try{await client.request('cancel',claim(binding));}catch{this.quarantined.add(context.projectRoot);}
        // Infrastructure errors and accepted activation cannot become not_started.
        return {output,error:activated?'Worker execution or cleanup is uncertain; do not replay.':'Worker preparation failed; no trusted no-effect receipt.',shellReset:true,uncertain:true};
      }
    }).finally(()=>entry.pending--);
    entry.tail=result.catch(()=>{});return result;
  }
  private async closeId(id:string,root:string){
    try{z.object({contextId:z.literal(id),cleanupConfirmed:z.literal(true)}).strict().parse(await(await this.client()).request('close',{contextId:id}));}
    catch{this.quarantined.add(root);throw new ToolError('Worker cleanup is uncertain.','SANDBOX_CLEANUP_FAILED');}
    this.contexts.delete(id);
  }
  async closeContext(context:ToolContext){const id=this.id(context),entry=this.contexts.get(id);if(!entry)return;await entry.tail;await this.closeId(id,entry.root);}
  async removeScope(root:string,chatId?:string){
    if(this.quarantined.has(root))throw new ToolError('Worker cleanup is uncertain.','SANDBOX_CLEANUP_FAILED');
    for(const [id,entry] of this.contexts){if(entry.root!==root||chatId&&entry.chatId!==chatId)continue;if(entry.pending)throw new ToolError('Worker command is pending.','CONFLICT');await this.closeId(id,root);}
  }
  async reset(root:string){
    await this.removeScope(root);
    if(!/^\/workspace\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(root))throw new ToolError('Invalid managed project');
    const project=root.slice('/workspace/'.length);
    try{z.object({project:z.literal(project),reset:z.literal(true),recipesRetained:z.literal(true),reinstallRequiresNewApproval:z.literal(true)}).strict().parse(await(await this.client()).request('reset',{project}));}
    catch{this.quarantined.add(root);throw new ToolError('Worker reset outcome is uncertain.','SANDBOX_CLEANUP_FAILED');}
  }
  async dispose(){this.disposed=true;await Promise.allSettled([...this.contexts.values()].map(entry=>entry.tail));await Promise.allSettled([...this.contexts].map(([id,entry])=>this.closeId(id,entry.root)));if(this.quarantined.size)throw new ToolError('Worker cleanup is uncertain.','SANDBOX_CLEANUP_FAILED');}

}
