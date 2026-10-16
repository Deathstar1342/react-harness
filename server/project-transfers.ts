import {runNativeOperation,assertNativePath} from './native-storage.js';
import {lstatSync,realpathSync} from 'node:fs';
import {lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {Project,ProjectTransferReceipt,ToolService} from '../shared/types.js';
import type {Runtime} from './runtime.js';
import type {Store} from './store.js';
import {WorkerClient,type WorkerTransport} from './worker-client.js';

export const transferCode=z.string().regex(/^[a-f0-9]{64}$/);
const statusSchema=z.object({id:z.uuid(),kind:z.enum(['import','export']),project:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),phase:z.enum(['copying','publishing','succeeded','failed','cancelled','uncertain']),code:z.string().regex(/^[A-Z_]+$/),residue:z.boolean(),manifestDigest:transferCode,files:z.number().int().min(0).max(50000),bytes:z.number().int().min(0).max(2147483648),excludedCount:z.number().int().min(0).max(50000),excluded:z.array(z.object({path:z.string().max(240),reason:z.string().max(200)}).strict()).max(100),history:z.boolean(),storageId:z.uuid(),sessionId:z.uuid(),identity:z.tuple([z.string().regex(/^[0-9]{1,30}$/),z.string().regex(/^[0-9]{1,30}$/)]).nullable()}).strict();
const pause=()=>new Promise(resolve=>setTimeout(resolve,200));
const key=(code:string)=>`transfer:${createHash('sha256').update(code).digest('hex')}`;
export class ProjectTransfers {
  constructor(private store:Store,private runtime:Runtime,private tools:ToolService,private connect:()=>Promise<WorkerTransport>=()=>WorkerClient.connect(),private workspace='/workspace'){}
  private claim(code:string) {
    transferCode.parse(code);
    if(this.store.getState(key(code),null))throw new Error('Transfer code already consumed. Inspect the retained copy and receipt; it will not be replayed.');
    this.store.setState(key(code),{phase:'claimed'});
  }
  private async copy(client:WorkerTransport,code:string,kind:'import'|'export',project:string|null,signal:AbortSignal) {
    let pinned:string|undefined;
    const parse=(raw:unknown)=>{
      const status=statusSchema.parse(raw);
      if(status.storageId!==client.storageId||status.sessionId!==client.sessionId||status.kind!==kind||project!==null&&status.project!==project)throw new Error('Transfer receipt identity mismatch');
      const {phase:_,code:__,residue:___,identity:____,...immutable}=status;
      const binding=JSON.stringify(immutable);
      if(pinned!==undefined&&pinned!==binding)throw new Error('Transfer immutable receipt changed');
      pinned=binding;
      this.store.setState(key(code),{phase:status.phase,receipt:status});
      return status;
    };
    if(signal.aborted)throw new Error('Transfer cancelled before dispatch');
    let result=parse(await client.request('transfer_begin',{code,kind,project}));
    const deadline=Date.now()+16*60_000;
    while(result.phase==='copying'||result.phase==='publishing') {
      if(signal.aborted||Date.now()>deadline)result=parse(await client.request('transfer_cancel',{code}));
      await pause();
      result=parse(await client.request('transfer_observe',{code}));
    }
    this.store.setState(key(code),{phase:result.phase,receipt:result});
    if(result.phase!=='succeeded'||signal.aborted)throw new Error(`Transfer incomplete (${result.code}). Retained residue may need inspection; no automatic retry or registration.`);
    return result;
  }
  async import(name:string,code:string,signal:AbortSignal):Promise<{project:Project;receipt:ProjectTransferReceipt}> {
    this.claim(code);
    try {
      const client=await this.connect();
      let receipt=await this.copy(client,code,'import',null,signal);
      if(!z.uuid().safeParse(receipt.project).success)throw new Error('Imported project identity is not a fresh managed UUID');
      const root=path.join(this.workspace,receipt.project);
      const verifyCompleted=async()=>{
        const retained=this.store.getState<{phase?:string;receipt?:ProjectTransferReceipt}>(key(code),{}),info=await lstat(root,{bigint:true});
        if(signal.aborted||!['succeeded','redeeming'].includes(retained.phase??'')||JSON.stringify(retained.receipt)!==JSON.stringify(receipt)||!info.isDirectory()||info.isSymbolicLink()||await realpath(root)!==root||!receipt.identity||info.dev.toString()!==receipt.identity[0]||info.ino.toString()!==receipt.identity[1]||receipt.storageId!==client.storageId||receipt.sessionId!==client.sessionId||this.store.projects().some(project=>project.path===root))throw new Error('Managed copy identity changed or completed receipt binding changed before redemption');
      };
      // Copy has a terminal exact receipt. Redemption is a separate one-use,
      // still-undispatched publication phase, never a repeat of accepted copy.
      await verifyCompleted();this.store.setState(key(code),{phase:'redeeming',receipt});
      return await runNativeOperation(async()=>{
        await verifyCompleted();assertNativePath(root,false);
        const redeemed=statusSchema.parse(await client.request('transfer_receipt',{code}));
        if(JSON.stringify(redeemed)!==JSON.stringify(receipt))throw new Error('Redeemed receipt differs from the verified completed transfer');
        receipt=redeemed;
        await verifyCompleted();assertNativePath(root,false);
        return this.store.transaction(()=>{
          const current=lstatSync(root,{bigint:true});assertNativePath(root,false);
          if(signal.aborted||realpathSync(root)!==root||!current.isDirectory()||current.isSymbolicLink()||current.dev.toString()!==receipt.identity![0]||current.ino.toString()!==receipt.identity![1]||this.store.projects().some(project=>project.path===root))throw new Error('Managed identity changed or was already registered');
          const project=this.store.createProject(name,root);
          this.store.setState(key(code),{phase:'registered',projectId:project.id,receipt});
          return {project,receipt};
        });
      });
    } catch(error) {
      this.store.setState(key(code),{...this.store.getState<Record<string,unknown>>(key(code),{}),phase:'unregistered',message:'Transfer outcome requires inspection. No automatic registration or replay.'});
      throw error;
    }
  }
  async release(projectId:string,code:string) {
    transferCode.parse(code);
    const project=this.store.project(projectId);
    if(!this.tools.removeScope)throw new Error('Tool reservation unavailable');
    return this.runtime.exclusiveProjectEdit(projectId,async()=>await this.tools.removeScope!(project.path,undefined,async()=>{
      const reservation=this.store.getState<{claim:string;sessionId:string;storageId:string;identity:[string,string]}|null>(`transfer:reservation:${projectId}`,null);
      if(!reservation||reservation.claim!==key(code))throw new Error('This code does not own the pending export reservation');
      const info=lstatSync(project.path,{bigint:true});
      if(!info.isDirectory()||info.isSymbolicLink()||info.dev.toString()!==reservation.identity[0]||info.ino.toString()!==reservation.identity[1])throw new Error('Reserved managed project identity changed');
      const client=await this.connect();
      if(client.storageId!==reservation.storageId)throw new Error('Export storage identity changed');
      const prior=this.store.getState<{receipt?:ProjectTransferReceipt}>(key(code),{}).receipt;
      const result=z.object({released:z.literal(true),receipt:statusSchema.nullable()}).strict().parse(await client.request('transfer_release',{code,project:path.basename(project.path),sessionId:reservation.sessionId,transferId:prior?.id??null,manifestDigest:prior?.manifestDigest??null}));
      if(result.receipt&&(result.receipt.kind!=='export'||result.receipt.project!==path.basename(project.path)||result.receipt.storageId!==reservation.storageId||result.receipt.sessionId!==reservation.sessionId||['copying','publishing'].includes(result.receipt.phase)||prior&&(result.receipt.id!==prior.id||result.receipt.manifestDigest!==prior.manifestDigest)))throw new Error('Export is not confirmed stopped');
      if(prior&&!result.receipt)throw new Error('Previously observed transfer claim disappeared');
      return this.store.transaction(()=>{
        const current=lstatSync(project.path,{bigint:true});
        if(current.dev.toString()!==reservation.identity[0]||current.ino.toString()!==reservation.identity[1]||this.store.getState<{claim:string}|null>(`transfer:reservation:${projectId}`,null)?.claim!==key(code))throw new Error('Export reservation changed');
        this.store.setState(key(code),{...this.store.getState<Record<string,unknown>>(key(code),{}),released:true,receipt:result.receipt});
        this.store.setState(`transfer:reservation:${projectId}`,null);this.store.removalError(projectId,'');
        return {released:true as const,receipt:result.receipt};
      });
    }),true);
  }
  async export(projectId:string,code:string,signal:AbortSignal):Promise<ProjectTransferReceipt> {
    const project=this.store.project(projectId);
    if(path.dirname(project.path)!==this.workspace||!this.tools.removeScope)throw new Error('Only managed project copies can be exported');
    return this.runtime.exclusiveRemoval(projectId,async()=>await this.tools.removeScope!(project.path,undefined,async()=>{
      const client=await this.connect();
      this.claim(code);
      // Persist before yielding: restart cannot silently clear a still-live export.
      const identity=lstatSync(project.path,{bigint:true});
      this.store.setState(`transfer:reservation:${projectId}`,{claim:key(code),sessionId:client.sessionId,storageId:client.storageId,identity:[identity.dev.toString(),identity.ino.toString()]});
      this.store.removalError(projectId,'Export is pending or uncertain. Wait for its confirmed receipt before editing this managed copy.');
      try {
        const result=await this.copy(client,code,'export',path.basename(project.path),signal);
        this.store.transaction(()=>{this.store.setState(`transfer:reservation:${projectId}`,null);this.store.removalError(projectId,'');});
        return result;
      } catch(error) {
        const claim=this.store.getState<{phase?:string}>(key(code),{});
        if(['failed','cancelled'].includes(claim.phase??''))this.store.transaction(()=>{this.store.setState(`transfer:reservation:${projectId}`,null);this.store.removalError(projectId,'');});
        throw error;
      }
    }));
  }
}
