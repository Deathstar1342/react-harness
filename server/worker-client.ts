import {createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {lstat,readFile} from 'node:fs/promises';
import {connect} from 'node:net';
import {z} from 'zod';
import {parseNativeJSON} from './native-json.js';

export const workerProtocol='abyssus-worker-v1' as const;
const hex=z.string().regex(/^[a-f0-9]{64}$/);
const identity=z.object({storageId:z.string().uuid(),projectId:hex,imageId:z.string().regex(/^sha256:[a-f0-9]{64}$/),layout:hex}).strict();
export const preparedSchema=z.object({claimId:z.string().uuid(),binding:hex,sessionId:z.string().uuid(),identity,expiresAt:z.number().int().safe().positive()}).strict();
export type WorkerBinding=z.infer<typeof preparedSchema>;
export const workerResultSchema=z.object({exitCode:z.number().int().min(-255).max(255),timedOut:z.boolean(),truncated:z.boolean(),shellReset:z.boolean(),backgroundPids:z.array(z.number().int().positive()).max(256),cancelled:z.boolean().optional()}).strict();
const descriptorSchema=z.object({protocol:z.literal(workerProtocol),sessionId:z.string().uuid(),key:hex,storageId:z.string().uuid(),socket:z.literal('/run/abyssus-broker/broker.sock')}).strict();
export function workerCanonical(value:unknown):string {
  const visit=(v:unknown):unknown=>{
    if(v===null||typeof v==='boolean')return v;
    if(typeof v==='number'){if(!Number.isSafeInteger(v))throw new Error('Invalid wire integer');return v;}
    if(typeof v==='string'){if(/[\uD800-\uDFFF]/u.test(v))throw new Error('Invalid wire Unicode');return v;}
    if(Array.isArray(v))return v.map(visit);
    if(typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype)return Object.fromEntries(Object.keys(v).sort().map(k=>[k,visit((v as Record<string,unknown>)[k])]));
    throw new Error('Invalid wire value');
  };
  return JSON.stringify(visit(value)).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
}
export const workerMac=(value:unknown,key:string)=>createHmac('sha256',key).update(workerCanonical(value)).digest('hex');
export class WorkerError extends Error {constructor(readonly code:string){super(code);}}
export interface WorkerTransport {request(op:string,body:unknown):Promise<unknown>;sessionId:string;storageId:string}
export class WorkerClient implements WorkerTransport {
  private constructor(private descriptor:z.infer<typeof descriptorSchema>){}
  get sessionId(){return this.descriptor.sessionId;}
  get storageId(){return this.descriptor.storageId;}
  static async connect():Promise<WorkerClient> {
    if(process.platform!=='linux'||process.env.HARNESS_EXECUTION_MODE!=='container')throw new WorkerError('WORKER_UNAVAILABLE');
    const file='/run/abyssus-broker/session.json',info=await lstat(file),parent=await lstat('/run/abyssus-broker');
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>2048||info.uid!==process.getuid?.()||(info.mode&0o077)!==0||!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o077)!==0)throw new WorkerError('UNTRUSTED_WORKER_SESSION');
    const descriptor=descriptorSchema.parse(parseNativeJSON(await readFile(file,'utf8')));
    if(descriptor.storageId!==process.env.HARNESS_STORAGE_ID)throw new WorkerError('WORKER_STORAGE_MISMATCH');
    return new WorkerClient(descriptor);
  }
  request(op:string,body:unknown):Promise<unknown> {
    const nonce=randomBytes(32).toString('hex');
    const unsigned={protocol:workerProtocol,sessionId:this.sessionId,nonce,expiresAt:Date.now()+30000,op,body};
    const wire=workerCanonical({...unsigned,mac:workerMac(unsigned,this.descriptor.key)})+'\n';
    if(Buffer.byteLength(wire)>262144)throw new WorkerError('WORKER_REQUEST_LIMIT');
    return new Promise((resolve,reject)=>{
      const socket=connect(this.descriptor.socket),parts:Buffer[]=[];let size=0,settled=false;
      const finish=(error?:Error,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
      const timer=setTimeout(()=>finish(new WorkerError('WORKER_REPLY_UNCERTAIN')),40000);
      socket.once('connect',()=>socket.write(wire));
      socket.on('data',(chunk:Buffer)=>{
        size+=chunk.length;if(size>262144)return finish(new WorkerError('WORKER_REPLY_LIMIT'));parts.push(chunk);
        if(!chunk.includes(10))return;
        try {
          const bytes=Buffer.concat(parts),raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
          if(!raw.endsWith('\n')||raw.slice(0,-1).includes('\n'))throw new Error();
          const value=z.object({protocol:z.literal(workerProtocol),sessionId:z.literal(this.sessionId),nonce:z.literal(nonce),ok:z.boolean(),result:z.unknown().optional(),error:z.string().regex(/^[A-Z_]{1,64}$/).optional(),mac:hex}).strict().parse(parseNativeJSON(raw));
          const {mac:signature,...signed}=value;
          if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(workerMac(signed,this.descriptor.key),'hex')))throw new Error();
          if(!value.ok)return finish(new WorkerError(value.error??'WORKER_FAILED'));
          if(value.error!==undefined||value.result===undefined)throw new Error();
          finish(undefined,value.result);
        }catch{return finish(new WorkerError('WORKER_INVALID_REPLY'));}
      });
      socket.once('error',()=>finish(new WorkerError('WORKER_REPLY_UNCERTAIN')));
      socket.once('close',()=>finish(new WorkerError('WORKER_REPLY_UNCERTAIN')));
    });
  }
}
export async function workerAvailable():Promise<boolean> {
  try {
    const client=await WorkerClient.connect();
    z.object({protocol:z.literal(workerProtocol),sessionId:z.literal(client.sessionId),storageId:z.literal(client.storageId),imageId:z.string().regex(/^sha256:[a-f0-9]{64}$/),available:z.literal(true)}).strict().parse(await client.request('hello',{}));
    return true;
  }catch{return false;}
}
export function newWorkerClaim(){return randomUUID();}
