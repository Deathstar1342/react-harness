import Fastify from 'fastify';
import {afterEach,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {BrowserPreviews} from '../server/browser-previews.js';
import type {Previews} from '../server/previews.js';
import type {BrowserProbeStep,BrowserProbeResult} from '../shared/browser-preview.js';
const cleanup:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
async function fixture(){
 const app=Fastify(),projectId=randomUUID(),processId=randomUUID(),documentId=randomUUID(),principal='paired-private-fixture';let now=Date.now(),resources=0,normal=0;const sessions=new Set<string>();let held:Promise<void>|undefined;
 const service={open:()=>{const id=randomUUID();sessions.add(id);return {id,projectId,processId,chatId:randomUUID(),generation:0,expiresAt:now+300000};},assertSession:(_project:string,id:string)=>{if(!sessions.has(id))throw new Error('Stale');},close:(_project:string,id:string)=>{sessions.delete(id);return {closed:true};},resource:async(_project:string,_id:string,target:string)=>{resources++;await held;return {status:200,contentType:target.endsWith('.js')?'text/javascript':'text/html',body:Buffer.from(target==='/'?'<h1>owned</h1>':'export{}').toString('base64')};}};
 const browser=new BrowserPreviews(service as unknown as Previews,()=>7300,()=>now);browser.register(app);app.addHook('onRequest',async()=>{normal++;});app.get('/*',async()=>({privateApp:true}));cleanup.push(()=>app.close());
 const start=()=>browser.start(projectId,processId,principal,documentId,{headers:{host:'127.0.0.1:7300'}} as never);
 const get=(url:string,dest:string|undefined='iframe',extra:Record<string,string>={})=>{const u=new URL(url);return app.inject({method:'GET',url:u.pathname+u.search,headers:{host:u.host,...(dest?{'sec-fetch-dest':dest}:{}),...extra}});};
 const grant=async()=>{let step=start(),proofId=step.id;for(let index=0;index<3;index++){
   expect((await get(step.url)).statusCode).toBe(200);const probe=(browser as any).probes.get(step.id);if(step.stage!=='enforced')for(const key of ['get','image','ws','redirect','navigation'])probe.records[step.stage][key]=1;
   const result:BrowserProbeResult={kind:'preview-capability',probeId:step.id,documentId,stage:step.stage,nonce:step.nonce,settled:true,error:false,peerOpened:step.stage!=='enforced',peerDelivered:step.stage!=='enforced'};
   const next=browser.advance(projectId,principal,{documentId,result});if('view'in next)return {view:next.view,proofId};step=next.step;
  }throw new Error('Missing terminal view');};
 return {app,browser,projectId,processId,documentId,principal,start,get,grant,get resources(){return resources;},get normal(){return normal;},advance:(ms:number)=>{now+=ms;},hold:(value:Promise<void>)=>{held=value;}};
}
it('known/unknown/malformed preview hosts route every API/encoded/SPA target exclusively, never app fallback',async()=>{
 const t=await fixture(),step=t.start();for(const host of [new URL(step.url).host,'a'.repeat(48)+'.localhost:7300','A'.repeat(48)+'.LOCALHOST:7300','x.localhost.:7300','x.localhost.evil:7300'])for(const url of ['/api/auth/pair','/api/backend/readiness','/api/%61uth','/missing-spa']){const reply=await t.app.inject({url,headers:{host,'sec-fetch-dest':'iframe'}});expect([403,410,421]).toContain(reply.statusCode);expect(reply.body).not.toContain('privateApp');}
 expect(t.resources).toBe(0);expect(t.normal).toBe(0);expect((await t.app.inject({url:'/normal',headers:{host:'127.0.0.1:7300'}})).json()).toEqual({privateApp:true});
});
it('no worker bytes before proof; a client result cannot waive missing positive counters or wrong principal/order',async()=>{
 const t=await fixture(),step=t.start();await t.get(step.url);const result:BrowserProbeResult={kind:'preview-capability',probeId:step.id,documentId:t.documentId,stage:step.stage,nonce:step.nonce,settled:true,error:false,peerOpened:true,peerDelivered:true};
 expect(()=>t.browser.advance(t.projectId,'foreign',{documentId:t.documentId,result})).toThrow();expect(()=>t.browser.advance(t.projectId,t.principal,{documentId:t.documentId,result:{...result,stage:'enforced'}})).toThrow();expect(()=>t.browser.advance(t.projectId,t.principal,{documentId:t.documentId,result})).toThrow(/not proven/);expect(t.resources).toBe(0);
});
it('consumes a single document ticket atomically and refuses replay/forged destination/cookies before network',async()=>{
 const t=await fixture(),{view}=await t.grant();let release!:()=>void;t.hold(new Promise(resolve=>{release=resolve;}));const first=t.get(view.url);await new Promise(resolve=>setTimeout(resolve,20));const duplicate=await t.get(view.url);expect(duplicate.statusCode).toBe(403);expect(t.resources).toBe(1);release();expect((await first).statusCode).toBe(200);
 for(const destination of ['document','iframe','iframe, script',undefined])expect((await t.get(view.url,destination)).statusCode).toBe(403);
 expect((await t.get(view.url,'empty',{cookie:'app_private=never',authorization:'Bearer denied'})).statusCode).toBe(403);expect(t.resources).toBe(1);
});
it('HTML never becomes a generic subresource; only exact worker asset routes pass and no app headers forward',async()=>{
 const t=await fixture(),{view}=await t.grant();await t.get(view.url);const base=new URL(view.url).origin;expect((await t.get(base+'/','empty')).statusCode).toBe(403);expect((await t.get(base+'/api/auth/pair','script')).statusCode).toBe(403);expect((await t.get(base+'/main.js','script')).statusCode).toBe(200);expect(t.normal).toBe(0);
});
it('close between ticket consumption/fetch/publication discards late bytes and consumed URL never revives',async()=>{
 const t=await fixture(),{view,proofId}=await t.grant();let release!:()=>void;t.hold(new Promise(resolve=>{release=resolve;}));const first=t.get(view.url);await new Promise(resolve=>setTimeout(resolve,20));t.browser.close(t.projectId,t.principal,t.documentId,proofId);release();expect((await first).statusCode).toBe(410);expect((await t.get(view.url)).statusCode).toBe(421);
});
it('late protected private hit revokes a granted linked view and all counters/expiry/capacity stay bounded',async()=>{
 const t=await fixture(),{view,proofId}=await t.grant();const probe=(t.browser as any).probes.get(proofId);const hit=`/_preview-sentinel/${proofId}/enforced/get/${probe.nonces.enforced}`;await t.app.inject({url:hit,headers:{host:'127.0.0.1:7300'}});expect((await t.get(view.url)).statusCode).toBe(421);expect(t.resources).toBe(0);
 for(let n=0;n<70;n++)await t.app.inject({url:hit,headers:{host:'127.0.0.1:7300'}});expect(probe.requests).toBeLessThanOrEqual(64);expect(probe.invalid).toBe(true);t.advance(120001);expect((await t.get(view.url)).statusCode).toBe(421);expect((t.browser as any).probes.size).toBe(0);
 for(let n=0;n<8;n++)t.start();expect(()=>t.start()).toThrow(/capacity/);expect((t.browser as any).probes.size).toBe(8);
});
it('refuses mismatched public Host port and reused/expired probe tickets without a worker read',async()=>{
 const t=await fixture();expect(()=>t.browser.start(t.projectId,t.processId,t.principal,t.documentId,{headers:{host:'127.0.0.1:7301'}} as never)).toThrow(/public port/);const step=t.start();expect((await t.get(step.url)).statusCode).toBe(200);expect((await t.get(step.url)).statusCode).toBe(403);t.advance(25001);expect((await t.get(step.url)).statusCode).toBe(410);expect(t.resources).toBe(0);
});

it('terminal proof cannot exceed the combined eight-record bound with retained probe tombstones',async()=>{
 const t=await fixture();for(let n=0;n<7;n++)t.start();await expect(t.grant()).rejects.toThrow(/capacity/);expect((t.browser as any).probes.size).toBe(8);expect((t.browser as any).views.size).toBe(0);expect(t.resources).toBe(0);
});
