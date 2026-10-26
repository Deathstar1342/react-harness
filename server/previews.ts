import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Store} from './store.js';
import {previewRecords,previewProject} from './preview-state.js';
import {ProcessJobs} from './process-jobs.js';
import {WorkerClient,type WorkerTransport} from './worker-client.js';
import type {PreviewEntry,PreviewSession} from '../shared/types.js';

export {previewPath} from '../shared/preview-policy.js';
import {previewPath} from '../shared/preview-policy.js';
const metadata=z.strictObject({handle:z.uuid(),status:z.number().int().min(200).max(599).refine(code=>code<300||code>=400),contentType:z.string().max(128),totalBytes:z.number().int().min(0).max(4*1024*1024)});
const page=z.strictObject({handle:z.uuid(),offset:z.number().int().nonnegative(),nextOffset:z.number().int().nonnegative(),totalBytes:z.number().int().nonnegative().max(4*1024*1024),data:z.string().max(44000)});
const media=/^(?:text\/(?:html|plain|css|javascript)|application\/(?:javascript|json|wasm|font-woff)|image\/(?:png|jpeg|gif|webp|svg\+xml|x-icon)|font\/(?:woff2?|ttf|otf))(?:; charset=utf-8)?$/;
interface Session {view:PreviewSession;binding:string;workerSession:string;status:PreviewEntry['status'];reason:string;active:number;closed:boolean}
/** Renderer sessions are ephemeral observations. Only ProcessJobs can own/start a writer. */
export class Previews {
  private sessions=new Map<string,Session>();
  private closing=false;
  constructor(private store:Store,private processes:ProcessJobs,private enabled:boolean,private connect:()=>Promise<WorkerTransport>=()=>WorkerClient.connect(),private now=Date.now){}
  private prune(){for(const [id,entry]of this.sessions)if(this.now()>entry.view.expiresAt){entry.closed=true;this.sessions.delete(id);}}
  private bound(projectId:string,processId:string){if(this.closing||!this.enabled)throw new Error('Isolated preview requires the container worker runtime');return this.processes.previewBinding(projectId,processId);}
  list(projectId:string):{entries:PreviewEntry[];browserSupported:false} {
    previewProject(this.store,projectId);this.prune();
    return {browserSupported:false,entries:previewRecords(this.store,projectId).filter(record=>record.port!==null).map(record=>{
      let status:PreviewEntry['status']=record.status==='completed'||record.status==='not_started'?'stopped':record.status==='running'?'starting':record.status;
      let reason='Recorded process outcome; opening a preview never starts or replays its command.';
      if(record.status==='running')try{this.bound(projectId,record.id);const entry=[...this.sessions.values()].find(entry=>entry.view.processId===record.id&&!entry.closed);if(entry){status=entry.status;reason=entry.reason;}else reason='Server process is running. Open preview to inspect its current HTTP response.';}catch{status='stale';reason='Current owned process/worker/project binding is unavailable; no network request admitted.';}
      return {processId:record.id,projectId,chatId:record.chatId,generation:record.generation,port:Number(record.port),status,reason};
    })};
  }
  open(projectId:string,processId:string):PreviewSession {
    this.prune();const {record,binding}=this.bound(projectId,processId);
    if(this.sessions.size>=8)throw new Error('Close an existing preview before opening another');
    const view:PreviewSession={id:randomUUID(),projectId,processId,chatId:record.chatId,generation:record.generation,expiresAt:this.now()+5*60_000};
    this.sessions.set(view.id,{view,binding:binding.binding,workerSession:binding.sessionId,status:'starting',reason:'Waiting for a bounded HTTP response.',active:0,closed:false});return view;
  }
  assertSession(projectId:string,id:string){this.prune();const entry=this.sessions.get(id);if(!entry||entry.closed||entry.view.projectId!==projectId)throw new Error('Preview session is stale');const {record,binding}=this.bound(projectId,entry.view.processId);if(record.generation!==entry.view.generation||binding.binding!==entry.binding||binding.sessionId!==entry.workerSession)throw new Error('Preview session binding changed');}
  close(projectId:string,id:string){const entry=this.sessions.get(id);if(!entry||entry.view.projectId!==projectId)throw new Error('Preview session is stale');entry.closed=true;this.sessions.delete(id);return {closed:true};}
  async resource(projectId:string,id:string,target:string,signal?:AbortSignal) {
    signal=AbortSignal.any([AbortSignal.timeout(25000),...(signal?[signal]:[])]);
    target=previewPath.parse(target);this.prune();const entry=this.sessions.get(id);
    if(!entry||entry.view.projectId!==projectId)throw new Error('Preview session is stale');
    const current=()=>{
      signal?.throwIfAborted();if(entry.closed||this.closing||this.now()>entry.view.expiresAt||this.sessions.get(id)!==entry)throw new Error('Preview session is stale');
      const value=this.bound(projectId,entry.view.processId);
      if(value.record.generation!==entry.view.generation||value.record.chatId!==entry.view.chatId||value.binding.binding!==entry.binding||value.binding.sessionId!==entry.workerSession)throw new Error('Preview worker binding is stale');
      return value;
    };
    const {binding}=current();if(entry.active>=2)throw new Error('Preview request limit reached');entry.active++;
    let client:WorkerTransport|undefined,handle:string|undefined;
    const token={claimId:binding.claimId,binding:binding.binding};
    try {
      client=await this.connect();current();if(client.sessionId!==binding.sessionId||client.storageId!==binding.identity.storageId)throw new Error('Preview broker session changed');
      const result=metadata.parse(await client.request('preview_open',{...token,path:target},signal));handle=result.handle;current();
      if(!media.test(result.contentType))throw new Error('Preview response type refused');
      let offset=0;const parts:Buffer[]=[];
      while(offset<result.totalBytes){
        const item=page.parse(await client.request('preview_read',{...token,handle,offset},signal));current();
        const bytes=Buffer.from(item.data,'base64');
        if(item.handle!==handle||item.offset!==offset||item.totalBytes!==result.totalBytes||bytes.length===0||bytes.length>32768||bytes.toString('base64')!==item.data||item.nextOffset!==offset+bytes.length||item.nextOffset>result.totalBytes)throw new Error('Preview response sequence refused');
        parts.push(bytes);offset=item.nextOffset;
      }
      current();if(target==='/'){entry.status=result.status>=200&&result.status<300?'ready':'failed';entry.reason=entry.status==='ready'?'Current owned server response loaded. Reload explicitly to observe changes.':'Server returned an HTTP failure; its process remains tracked.';}
      return {status:result.status,contentType:result.contentType,body:Buffer.concat(parts,result.totalBytes).toString('base64')};
    }catch{if(!entry.closed){entry.status='failed';entry.reason='Preview response failed or binding changed. Server process remains tracked; no start or replay occurred.';}throw new Error('Preview response unavailable; inspect the owned process and reload deliberately.');}
    finally{entry.active--;if(client&&handle)try{await client.request('preview_close',{...token,handle},AbortSignal.timeout(2000));}catch{/* bounded observation buffer expires; never retry execution or clear ownership */}}
  }
  shutdown(){this.closing=true;for(const entry of this.sessions.values())entry.closed=true;this.sessions.clear();}
}
