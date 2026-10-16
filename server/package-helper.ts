/** Backend-only trusted client. Never instantiate from model or renderer input.
 * There are deliberately no HTTP routes, automatic retries, setup-on-launch,
 * or policy decisions here. A lost execute reply requires status/reconcile.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { connect } from 'node:net';
import { z } from 'zod';
import type { LocalPackageTarget, PackageHelperDecision, PackageHelperRecord, PackageHelperRequest, PackageHelperTarget } from '../shared/types.js';

export const helperProtocol='abyssus-helper-v1' as const;
const hex=z.string().regex(/^[a-f0-9]{64}$/);
const descriptorSchema=z.object({protocol:z.literal(helperProtocol),key:hex,uid:z.number().int().positive(),installationId:z.string().uuid(),socket:z.literal('/run/abyssus-helper/control.sock')}).strict();
export const packageRequestSchema=z.object({requestId:z.string().uuid(),targetId:hex,manager:z.literal('apt'),packages:z.array(z.object({name:z.string().regex(/^[a-z0-9][a-z0-9+.-]{1,63}$/),version:z.string().regex(/^[0-9][A-Za-z0-9.+:~\-]{0,127}$/).optional()}).strict()).min(1).max(16)}).strict().refine(v=>new Set(v.packages.map(p=>p.name)).size===v.packages.length);
const decisionSchema=z.object({requestId:z.string().uuid(),previewDigest:hex,decisionNonce:hex,expiresAt:z.number().int().positive()}).strict();

/** ASCII protocol inputs; sorted JSON matches the helper's canonical encoding. */
export function helperCanonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(helperCanonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value).filter(k=>(value as Record<string,unknown>)[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+helperCanonical((value as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
}
export function helperMac(value:unknown,key:string){return createHmac('sha256',key).update(helperCanonical(value)).digest('hex');}
export class PackageHelperError extends Error {
  constructor(readonly code:string){super(code);this.name='PackageHelperError';}
}
export class PackageHelperClient {
  #descriptor:z.infer<typeof descriptorSchema>;
  private constructor(descriptor:z.infer<typeof descriptorSchema>){this.#descriptor=descriptor;}
  installationId(){return this.#descriptor.installationId;}
  static async connect():Promise<PackageHelperClient> {
    if(process.env.HARNESS_EXECUTION_MODE==='container')throw new PackageHelperError('CONTAINER_EXECUTION_UNAVAILABLE');
    if(process.platform!=='linux'||!process.getuid?.())throw new PackageHelperError('HELPER_UNSUPPORTED_CLIENT');
    const file='/etc/abyssus-helper/client.json';
    for(const path of ['/','/etc','/etc/abyssus-helper',file]) {
      const info=await lstat(path);
      if(info.isSymbolicLink()||info.uid!==0||(info.mode&0o022)!==0)throw new PackageHelperError('UNTRUSTED_HELPER_DESCRIPTOR');
    }
    const descriptor=descriptorSchema.parse(JSON.parse(await readFile(file,'utf8')));
    if(descriptor.uid!==process.getuid!())throw new PackageHelperError('HELPER_UNAUTHORIZED_PRINCIPAL');
    return new PackageHelperClient(descriptor);
  }
  private async request<T>(action:string,body:unknown):Promise<T> {
    const nonce=randomBytes(32).toString('hex');
    const unsigned={protocol:helperProtocol,nonce,expiresAt:Date.now()+15000,action,body};
    const wire=helperCanonical({...unsigned,mac:helperMac(unsigned,this.#descriptor.key)})+'\n';
    return new Promise((resolve,reject)=>{
      let size=0,parts:Buffer[]=[];
      const socket=connect(this.#descriptor.socket);
      // Timeout never implies cancellation; no automatic reconnect/retry.
      const timer=setTimeout(()=>socket.destroy(new PackageHelperError('HELPER_REPLY_UNCERTAIN')),300_000);
      socket.once('connect',()=>socket.write(wire));
      socket.on('data',(chunk:Buffer)=>{
        size+=chunk.length;
        if(size>256*1024)return socket.destroy(new PackageHelperError('HELPER_INVALID_REPLY'));
        parts.push(chunk);
        if(!chunk.includes(10))return;
        try {
          const raw=Buffer.concat(parts).toString('utf8');
          if(!raw.endsWith('\n')||raw.slice(0,-1).includes('\n'))throw new Error();
          const response=JSON.parse(raw) as Record<string,unknown>;
          const mac=response.mac;delete response.mac;
          if(typeof mac!=='string'||!/^[a-f0-9]{64}$/.test(mac)||!timingSafeEqual(Buffer.from(mac,'hex'),Buffer.from(helperMac(response,this.#descriptor.key),'hex'))||response.protocol!==helperProtocol||response.nonce!==nonce)throw new Error();
          if(response.ok!==true)throw new PackageHelperError(typeof response.error==='string'&&/^[A-Z_]{1,64}$/.test(response.error)?response.error:'HELPER_FAILED');
          resolve(response.result as T);socket.end();
        }catch(error){socket.destroy(error instanceof PackageHelperError?error:new PackageHelperError('HELPER_INVALID_REPLY'));}
      });
      socket.once('error',error=>reject(error instanceof PackageHelperError?error:new PackageHelperError('HELPER_REPLY_UNCERTAIN')));
      socket.once('close',()=>{clearTimeout(timer);reject(new PackageHelperError('HELPER_REPLY_UNCERTAIN'));});
    });
  }
  async hello(){
    const reply=await this.request<{protocol:typeof helperProtocol;target:PackageHelperTarget}>('hello',{});
    if(reply.protocol!==helperProtocol||reply.target.scope==='project-container'||reply.target.installationId!==this.#descriptor.installationId)throw new PackageHelperError('HELPER_TARGET_MISMATCH');
    return {...reply,target:reply.target as LocalPackageTarget};
  }
  prepare(request:PackageHelperRequest){return this.request<PackageHelperRecord>('prepare',packageRequestSchema.parse(request));}
  authorize(decision:PackageHelperDecision){return this.request<PackageHelperRecord>('authorize',decisionSchema.parse(decision));}
  execute(decision:PackageHelperDecision){return this.request<PackageHelperRecord>('execute',decisionSchema.parse(decision));}
  status(requestId:string){return this.request<PackageHelperRecord>('status',{requestId:z.string().uuid().parse(requestId)});}
  reconcile(requestId:string){return this.request<PackageHelperRecord>('reconcile',{requestId:z.string().uuid().parse(requestId)});}
}
