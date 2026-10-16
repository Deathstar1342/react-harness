import { NativeStateCheck,type NativeObservation } from './native-state-check.js';
import type {FastifyInstance} from 'fastify';
/** Trusted-process native storage authority. No renderer/config setter exists. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NativeBindPolicy } from './native-bind-policy.js';
import { NativeStorageGate } from './native-storage-gate.js';
let authority:{policy:NativeBindPolicy;gate:NativeStorageGate;state?:NativeStateCheck;failed:boolean}|undefined;
let privateDepth=0;let privateStarted=0;
export function installNativeStorage(policy:NativeBindPolicy,check:()=>Promise<unknown>,observation?:NativeObservation){
 if(authority)throw new Error('Native storage authority already installed');
 const gate=new NativeStorageGate(policy,check,Date.now,poisonNativeAuthority);
 authority={policy,gate,failed:false};if(observation)authority.state=new NativeStateCheck(observation,poisonNativeAuthority);
}
function poisonNativeAuthority(){if(!authority||authority.failed)return;authority.failed=true;authority.gate.poison();authority.state?.poison();}
function current(){
 if(authority?.failed)throw new Error('Native storage authority failed; explicit recovery required');
 if(process.env.HARNESS_NATIVE_BIND_DIGEST&&!authority)throw new Error('Native storage authority is not authenticated');
 return authority;
}
export function nativeStorageActive(){return !!current();}
export async function runNativeOperation<T>(operation:()=>T|Promise<T>):Promise<T>{
 const active=current();active?.state?.assertHealthy();return active?active.gate.run(operation):operation();
}
export function assertNativePath(filename:string,privateClass=true,creating=false){
 const active=current();if(!active)return;
 if(!path.posix.isAbsolute(filename)||path.posix.normalize(filename)!==filename)throw new Error('Invalid native storage path');
 let checked=filename;
 if(creating){let depth=0;while(!existsSync(checked)){if(++depth>64)throw new Error('Native storage path exceeds bound');const parent=path.posix.dirname(checked);if(parent===checked)throw new Error('Native storage root missing');checked=parent;}}
 if(!active.gate.permits(checked,privateClass))throw new Error('Native storage freshness or identity changed; explicit recovery required');
}

export function registerNativeStorageScope(app:FastifyInstance){
 app.addHook('preHandler',(_request,_reply,done)=>{void runNativeOperation(()=>done()).catch(error=>done(error as Error));});
}

/** A private-state unit is synchronous and never grants workspace authority. */
export function nativePrivateUnit<T>(operation:()=>T):T {
 const active=current();if(!active)return operation();
 if(!active.state)throw new Error('Native private-state observer is not installed');
 active.state.assertHealthy();
 if(privateDepth){if(performance.now()-privateStarted>2000){active.state.poison();throw new Error('Native private-state unit exceeded its bound');}return operation();}
 active.state.check();privateStarted=performance.now();privateDepth++;
 try{const result=operation();if(result&&typeof (result as {then?:unknown}).then==='function')throw new Error('Private-state units cannot cross await');return result;}
 finally{privateDepth--;}
}
export function nativePrivateCommit(){const active=current();if(!active)return;if(!active.state)throw new Error('Native private-state observer is not installed');active.state.check();}
export function nativePrivatePath(filename:string,creating=false){
 const active=current();if(!active)return;
 if(!privateDepth)throw new Error('Native private-state path requires a synchronous unit');
 active.state!.assertHealthy();let checked=filename;
 if(creating){let depth=0;while(!existsSync(checked)){if(++depth>64)throw new Error('Private path exceeds bound');checked=path.dirname(checked);}}
 try{if(!active.policy.permits(checked,true))throw new Error('Native private-state path changed');}catch(error){poisonNativeAuthority();throw error;}
}

/** Final native worker wire check; observing/cleaning up never renews a scope. */
export function assertNativeDispatch(op:string){
 if(['redeem_storage','storage_check','hello','desktop_hello','observe','install_status','transfer_observe','cancel','close','shutdown','transfer_cancel','transfer_release'].includes(op))return;
 if(!['prepare','activate','install_hello','install_prepare','install_authorize','install_execute','install_reconcile','transfer_begin','transfer_receipt','reset'].includes(op))throw new Error('Unknown native worker operation');
 const active=current();if(!active)throw new Error('Native storage authority is not authenticated');
 active.state?.assertHealthy();
 if(!active.gate.permits(active.policy.roots.workspace,false))throw new Error('Native dispatch freshness changed; explicit recovery required');
}
