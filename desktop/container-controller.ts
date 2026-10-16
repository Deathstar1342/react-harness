import { spawn,type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes,randomUUID,createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { detectContainerEngine,engineQuery,sameEngine,type EngineIdentity } from './container-engine.js';
import { supportRuntime } from './support-runtime.js';
import { descriptorSchema,loopbackAddress } from './backend-wire.js';
import { waitForReadiness } from './readiness.js';
import { signBackendRequest,verifyBackendProof } from '../server/lifecycle.js';
import type { BackendIdentity } from '../shared/types.js';
import type { DesktopStatus } from './contracts.js';
import type { BackendTarget } from './proxy.js';
const hex=z.string().regex(/^[a-f0-9]{64}$/);
const readySchema=descriptorSchema.extend({reconnect:z.boolean(),key:hex,token:hex}).strict();
const payloadSchema=z.object({version:z.literal(1),source:z.string().regex(/^[a-f0-9]{40}$/),controllerImage:z.string().regex(/^sha256:[a-f0-9]{64}$/),workerImage:z.string().regex(/^sha256:[a-f0-9]{64}$/)}).strict();
export interface ContainerSelection {path:string;storageId:string}
/** Only main creates selection inputs. Renderer gets no supervisor request method. */
export class ContainerDesktopController {
  state:DesktopStatus={runtime:'container',platform:process.platform,phase:'setup',distributions:[],container:{available:false},message:'Checking the local container runtime...'};
  private engine?:EngineIdentity;
  private child?:ChildProcessWithoutNullStreams;
  private active?:BackendTarget;
  private identity?:BackendIdentity;
  private key?:string;
  private busy=false;
  private poisoned=false;
  private closingChild?:ChildProcessWithoutNullStreams;
  private sequence=0;
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  selection?:ContainerSelection;
  constructor(private readonly appRoot:string,private readonly changed:()=>void=()=>{}){}
  target(){return this.state.phase==='ready'?this.active:undefined;}
  async inventory(){
    try{this.engine=await detectContainerEngine(process.platform,engineQuery(this.appRoot));this.state.container={...this.state.container,available:true,engine:this.engine.context,engineDataRoot:this.engine.dataRoot};this.state.message='Choose persistent app storage, then open your workspace. Docker images and build cache use the separate engine storage location.';}
    catch(error){this.engine=undefined;this.state.container={...this.state.container,available:false};this.state.message=error instanceof Error&&error.name==='SupportRuntimeUnavailable'?'The private desktop runtime is missing or failed validation. Repair desktop runtime staging, then check again.':'A supported local Docker Linux engine is unavailable. Start Docker Desktop on Windows or your local Docker Engine on Linux, then check again. No runtime or system settings were changed.';}
    return this.state;
  }
  async start(selection:ContainerSelection,mode:'existing'|'initialize'){
    if(this.busy||this.child)throw new Error('Finish the owned supervisor transition before reopening storage.');
    if(!this.engine)throw new Error('Check the local engine before opening storage.');
    this.busy=true;
    try{
      const actual=await detectContainerEngine(process.platform,engineQuery(this.appRoot));sameEngine(this.engine,actual);
      const executable=supportRuntime(path.resolve(this.appRoot,'../support-runtime'));
      const payload=payloadSchema.parse(JSON.parse(readFileSync(path.join(this.appRoot,'container-runtime.json'),'utf8')));
      this.selection=selection;this.state={...this.state,phase:'starting',container:{...this.state.container!,storage:{displayPath:selection.path,id:selection.storageId}},message:'Checking storage ownership and starting the private controller...'};this.changed();
      const env:NodeJS.ProcessEnv={};for(const key of ['PATH','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','SystemRoot','WINDIR','TEMP','TMP','TMPDIR'])if(process.env[key])env[key]=process.env[key];
      const child=spawn(executable,['-I','-B',path.join(this.appRoot,'containers/broker/support_entry.py')],{cwd:path.dirname(executable),env,windowsHide:true,stdio:'pipe'});this.child=child;
      this.poisoned=false;
      let line='',bytes=0,settled=false;
      const ready=new Promise<z.infer<typeof readySchema>>((resolve,reject)=>{
        const deadline=setTimeout(()=>{settled=true;reject(new Error('Container startup is unverified. Ownership remains retained; inspect recovery before retrying.'));},240000);
        const failed=()=>{clearTimeout(deadline);if(!settled){settled=true;reject(new Error('Container supervisor exited before readiness. Storage and recovery records are preserved.'));}};
        child.once('error',failed);child.once('close',failed);
        child.stdout.on('data',(chunk:Buffer)=>{
          if(this.poisoned)return;
          bytes+=chunk.length;if(bytes>262144){failed();this.poisonTransport();return;}line+=chunk.toString();
          for(let end;(end=line.indexOf('\n'))>=0;){const raw=line.slice(0,end);line=line.slice(end+1);bytes=Buffer.byteLength(line);
            try{const frame=JSON.parse(raw) as Record<string,unknown>;
              if(!settled){if(Object.keys(frame).length!==1)throw new Error('Invalid startup envelope');if(frame.error){const code=z.string().regex(/^[A-Z_]{1,64}$/).parse(frame.error);clearTimeout(deadline);settled=true;reject(new Error('Container startup refused: '+code));}else{const value=readySchema.parse(frame.ready);clearTimeout(deadline);settled=true;resolve(value);}}
              else if(typeof frame.id==='number'&&Number.isSafeInteger(frame.id)&&Object.keys(frame).every(key=>['id','result','error'].includes(key))&&('result' in frame)!==('error' in frame)){const pending=this.pending.get(frame.id);if(!pending)continue;clearTimeout(pending.timer);this.pending.delete(frame.id);if(frame.error)pending.reject(new Error('Container operation is unverified; ownership and records are retained.'));else pending.resolve(frame.result);}else throw new Error('Invalid supervisor reply');
            }catch{failed();this.poisonTransport();return;}
          }
        });
      });
      child.stderr.on('data',()=>{});
      child.once('close',()=>{if(this.child!==child)return;this.child=undefined;this.active=undefined;this.failPending();if(this.state.phase!=='setup'&&this.closingChild!==child){this.state.phase='failed';this.state.message='Desktop supervision ended. Explicitly reopen the same storage to verify recovery; no commands or goals will replay.';this.changed();}});
      child.stdin.write(JSON.stringify({...selection,...(process.platform==='win32'?{runtimeDigest:createHash('sha256').update(readFileSync(path.resolve(this.appRoot,'../support-runtime/manifest.json'))).digest('hex')}:{}),storage:selection.path,path:undefined,mode,context:this.engine.context,engineId:this.engine.id,controllerImage:payload.controllerImage,workerImage:payload.workerImage,key:randomBytes(32).toString('hex'),token:randomBytes(32).toString('hex'),launchId:randomUUID()})+'\n');
      const descriptor=await ready,address=loopbackAddress(descriptor.address);
      const readiness=new AbortController();
      const unavailable=()=>readiness.abort(new Error('Supervisor exited during readiness.'));
      child.once('close',unavailable);child.once('error',unavailable);
      try{await waitForReadiness(address,descriptor.key,descriptor.identity,readiness.signal);}finally{child.off('close',unavailable);child.off('error',unavailable);}
      if(this.poisoned||this.child!==child||child.exitCode!==null)throw new Error('Supervisor exited during readiness.');
      this.identity=descriptor.identity;this.key=descriptor.key;this.active={address,token:descriptor.token,sessionId:`${descriptor.identity.profileId}/${descriptor.identity.instanceId}`};
      this.state={...this.state,phase:'ready',sessionId:this.active.sessionId,message:descriptor.reconnect?'Reconnected to the exact owned controller. Review any interrupted or uncertain work.':'Connected. Configure your provider and models in Settings; goals start only when you choose to run them.'};this.changed();return this.state;
    }catch(error){this.state.phase='failed';this.state.message=error instanceof Error?error.message:'Container startup failed.';this.changed();throw error;}finally{this.busy=false;}
  }
  private poisonTransport(){this.poisoned=true;this.state.phase='failed';this.state.message='Private supervisor transport failed validation. Ownership and buffers remain for explicit recovery.';this.failPending();this.changed();}
  private failPending(){for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new Error('Supervisor reply is uncertain; no operation was replayed.'));}this.pending.clear();}
  private request(request:object,timeout=30000):Promise<unknown>{
    if(this.poisoned||!this.child||this.child.exitCode!==null)throw new Error('Owned supervisor is unavailable.');
    const id=++this.sequence,child=this.child;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Supervisor reply is uncertain; no operation was replayed.'));},timeout);this.pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,request})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(new Error('Supervisor reply is uncertain.'));}});});
  }
  async stop(){
    if(this.busy)throw new Error('Wait for the current desktop transition.');
    if(!this.child)return;
    if(!this.active||!this.identity||!this.key)throw new Error('Startup outcome is uncertain. Keep storage selected for recovery.');
    this.busy=true;this.state.phase='stopping';this.state.message='Waiting for controller, workers and installs to drain. Uncertain work is retained.';this.changed();
    try{
      const request=signBackendRequest(this.key,'shutdown',this.identity.instanceId);
      const response=await fetch(this.active.address+'/api/backend/shutdown',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),redirect:'error',signal:AbortSignal.timeout(5000)});
      if(!response.ok||!verifyBackendProof(this.key,'shutdown',request,await response.json()))throw new Error('Shutdown identity is unverified.');
      const end=Date.now()+360000;
      while(!z.object({stopped:z.boolean()}).strict().parse(await this.request({op:'stopped'})).stopped){if(Date.now()>end)throw new Error('Controller drain remains unverified.');await new Promise(resolve=>setTimeout(resolve,250));}
      z.object({stopped:z.literal(true)}).strict().parse(await this.request({op:'drain'},400000));
      const child=this.child;this.closingChild=child;
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>{child.off('close',closed);reject(new Error('Supervisor exit remains unverified.'));},20000);
        const closed=(code:number|null)=>{clearTimeout(timer);code===0?resolve():reject(new Error('Supervisor exit remains unverified.'));};
        child.once('close',closed);child.stdin.end();
      });
      this.state.phase='setup';this.state.message='Owned containers stopped. Persistent storage was preserved.';this.active=undefined;this.key=undefined;this.identity=undefined;this.changed();
    }catch(error){this.state.phase='failed';this.state.message='Shutdown is unverified. Buffers, ownership and recovery records remain retained.';this.changed();throw error;}finally{this.closingChild=undefined;this.busy=false;}
  }
  async selectTransfer(input:{kind:'import'|'export';path:string;project:string|null;included:string[];history:boolean}){
    if(this.busy||this.state.phase!=='ready')throw new Error('Open the selected storage before copying a project.');
    return z.object({handle:hex,files:z.number().int().nonnegative(),bytes:z.number().int().nonnegative(),excluded:z.array(z.object({path:z.string(),reason:z.string()})),excludedCount:z.number().int().nonnegative(),history:z.boolean()}).strict().parse(await this.request({op:'transfer-select',...input},120000));
  }
  async authorizeTransfer(handle:string){return z.object({code:hex}).strict().parse(await this.request({op:'transfer-authorize',handle}));}
  async discardTransfer(handle:string){await this.request({op:'transfer-discard',handle});}
}
