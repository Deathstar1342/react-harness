import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BackendIdentity, BackendProofRequest, BackendProof } from '../shared/types.js';

const protocol='abyssus-backend-v1';
const schema=z.object({instanceId:z.uuid(),nonce:z.string().regex(/^[a-f0-9]{64}$/),expiresAt:z.number().int(),mac:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const proofSchema=z.object({action:z.enum(['readiness','shutdown']),identity:z.object({protocol:z.literal(protocol),instanceId:z.uuid(),profileId:z.uuid(),pid:z.number().int().positive(),platform:z.string().min(1).max(32),state:z.enum(['starting','ready','stopping','stopped','failed'])}).strict(),nonce:z.string().regex(/^[a-f0-9]{64}$/),mac:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const digest=(key:string,text:string)=>createHmac('sha256',key).update(text).digest('hex');
const requestText=(action:string,input:Omit<BackendProofRequest,'mac'>)=>JSON.stringify([protocol,action,input.instanceId,input.nonce,input.expiresAt]);
export function signBackendRequest(key:string,action:'readiness'|'shutdown',instanceId:string,now=Date.now()):BackendProofRequest {
  const input={instanceId,nonce:randomBytes(32).toString('hex'),expiresAt:now+15000};
  return {...input,mac:digest(key,requestText(action,input))};
}
export function verifyBackendProof(key:string,action:'readiness'|'shutdown',request:BackendProofRequest,input:unknown):boolean {
  const parsed=proofSchema.safeParse(input);if(!parsed.success)return false;
  const proof=parsed.data;
  if(proof.action!==action || proof.identity.instanceId!==request.instanceId || proof.identity.protocol!==protocol || proof.nonce!==request.nonce || request.expiresAt<Date.now())return false;
  const expected=digest(key,JSON.stringify([protocol,'proof',action,request.nonce,request.expiresAt,proof.identity]));
  return /^[a-f0-9]{64}$/.test(proof.mac) && timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(proof.mac,'hex'));
}
export class BackendLifecycle {
  readonly instanceId=randomUUID();
  readonly key:string;
  private state:BackendIdentity['state']='starting';
  private used=new Map<string,number>();
  private shutdown?:Promise<void>;
  private failureListeners=new Set<()=>void>();
  constructor(readonly profileId:string,key=randomBytes(32).toString('hex')) {
    if(!/^[a-f0-9]{64}$/.test(key))throw new Error('HARNESS_LAUNCH_KEY must be 32 random bytes encoded as lowercase hex');
    this.key=key;
  }
  ready(){this.state='ready';}
  identity():BackendIdentity{return {protocol,instanceId:this.instanceId,profileId:this.profileId,pid:process.pid,platform:process.platform,state:this.state};}
  onFailure(listener:()=>void) {this.failureListeners.add(listener);if(this.state==='failed')listener();return()=>{this.failureListeners.delete(listener);};}
  stop(close:()=>Promise<void>):Promise<void> {
    if(this.shutdown)return this.shutdown;
    this.state='stopping';
    this.shutdown=Promise.resolve().then(close).then(()=>{this.state='stopped';},error=>{this.state='failed';for(const listener of this.failureListeners)try{listener();}catch{/* Observers cannot change ownership or the cleanup result. */}throw error;});
    return this.shutdown;
  }
  register(app:FastifyInstance,close:()=>Promise<void>) {
    app.addHook('onRequest',async(request,reply)=>{
      if(this.state!=='ready' && !request.url.startsWith('/api/backend/'))return reply.code(503).send({error:'Backend is not accepting work'});
    });
    for(const action of ['readiness','shutdown'] as const)app.post(`/api/backend/${action}`,async(request,reply)=>{
      const input=schema.parse(request.body),now=Date.now();
      for(const [nonce,expiry] of this.used)if(expiry<now)this.used.delete(nonce);
      const expected=digest(this.key,requestText(action,input));
      if(input.instanceId!==this.instanceId || input.expiresAt<now || input.expiresAt>now+30000 || this.used.has(input.nonce) ||
        !timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(input.mac,'hex')))return reply.code(403).send({error:'Backend authentication failed'});
      if(this.used.size>=4096)return reply.code(429).send({error:'Too many lifecycle requests'});
      this.used.set(input.nonce,input.expiresAt);
      if(action==='shutdown') {
        if(!this.shutdown)this.state='stopping';
        reply.raw.once('finish',()=>{void this.stop(close).catch(()=>{ /* failure retains ownership */ });});
      }
      const identity=this.identity();
      return {action,identity,nonce:input.nonce,mac:digest(this.key,JSON.stringify([protocol,'proof',action,input.nonce,input.expiresAt,identity]))} satisfies BackendProof;
    });
  }
}
