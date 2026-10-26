import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {browserProbeResult,browserProbeStage,type BrowserProbeStage,type BrowserProbeStep,type BrowserPreviewView} from '../shared/browser-preview.js';
import {previewPath} from '../shared/preview-policy.js';
import type {Previews} from './previews.js';
import {runNativeOperation} from './native-storage.js';
import {probeDocument} from './browser-preview-probe.js';

const random=()=>randomBytes(24).toString('hex');
const stages:BrowserProbeStage[]=['positive','enforced','positiveAgain'];
const kinds=['get','image','ws','redirect','navigation'] as const;
type Counters=Record<typeof kinds[number],number>;
const counts=():Counters=>({get:0,image:0,ws:0,redirect:0,navigation:0});
interface Probe {id:string;projectId:string;processId:string;sessionId:string;principal:string;documentId:string;host:string;port:number;nonce:string;nonces:Record<BrowserProbeStage,string>;ticket:string;stage:BrowserProbeStage;stageAt:number;expiresAt:number;used:boolean;requests:number;requestBytes:number;responseBytes:number;records:Record<BrowserProbeStage,Counters>;closed:boolean;invalid:boolean;viewId?:string}
interface View {id:string;projectId:string;principal:string;documentId:string;host:string;port:number;ticket:string;used:boolean;expiresAt:number;probeId:string;abort:AbortController}
export class BrowserPreviews {
  private probes=new Map<string,Probe>();
  private views=new Map<string,View>();
  private closing=false;
  constructor(private previews:Previews,private publicPort:()=>number|undefined,private now=Date.now){}
  private origin(host:string,port:number){return `http://${host}:${port}`;}
  private headers(origin:string,port:number,enforced=true,probe=false,sentinel=''){
    const privateHTTP=probe?` ${sentinel}/`:'',privateWS=probe?` ${sentinel.replace('http:','ws:')}/`:'';
    return {'Cache-Control':'no-store, max-age=0','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':'null','Permissions-Policy':'camera=(), microphone=(), geolocation=(), usb=(), serial=(), payment=(), display-capture=()',
      'Content-Security-Policy':`default-src 'none'; script-src ${origin} 'unsafe-inline'; style-src ${origin} 'unsafe-inline'; img-src ${origin} data:${privateHTTP}; font-src ${origin}; connect-src ${origin}${privateHTTP}${privateWS}; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts; frame-ancestors http://127.0.0.1:${port} http://localhost:${port} http://127.0.0.1:5173 http://localhost:5173`,
      ...(enforced?{'Connection-Allowlist':'(response-origin); redirects=block; webrtc=block'}:{})};
  }
  private prune(){const now=this.now();for(const [id,view]of this.views)if(now>view.expiresAt)this.dropView(view);for(const [id,probe]of this.probes)if(now>probe.expiresAt){try{this.previews.close(probe.projectId,probe.sessionId);}catch{/* already closed */}this.probes.delete(id);}}
  supported(){try{return !this.closing&&this.publicPort()!==undefined;}catch{return false;}}
  private checkPort(request:FastifyRequest){const port=this.publicPort();if(!port||this.closing)throw new Error('This controller has no proven same-public-port browser preview binding');const host=request.headers.host;if(host!==`127.0.0.1:${port}`&&host!==`localhost:${port}`)throw new Error('Browser preview public port does not match the trusted listener');return port;}
  private step(probe:Probe):BrowserProbeStep{return {id:probe.id,documentId:probe.documentId,stage:probe.stage,nonce:probe.nonce,url:this.origin(probe.host,probe.port)+`/stage/${probe.stage}?ticket=${probe.ticket}`,expiresAt:probe.expiresAt};}
  start(projectId:string,processId:string,principal:string,documentId:string,request:FastifyRequest){
    this.prune();const port=this.checkPort(request);z.uuid().parse(documentId);if(this.probes.size+this.views.size>=8)throw new Error('Browser preview capability capacity reached; close views or wait for expired probes');
    const session=this.previews.open(projectId,processId),id=randomUUID(),now=this.now(),nonces={positive:random(),enforced:random(),positiveAgain:random()};
    const probe:Probe={id,projectId,processId,sessionId:session.id,principal,documentId,host:random()+'.localhost',port,nonce:nonces.positive,nonces,ticket:random(),stage:'positive',stageAt:now,expiresAt:now+120000,used:false,requests:0,requestBytes:0,responseBytes:0,records:{positive:counts(),enforced:counts(),positiveAgain:counts()},closed:false,invalid:false};this.probes.set(id,probe);return this.step(probe);
  }
  advance(projectId:string,principal:string,input:{documentId:string;result:z.infer<typeof browserProbeResult>}) :{step:BrowserProbeStep}|{view:BrowserPreviewView}{
    this.prune();const result=browserProbeResult.parse(input.result),probe=this.probes.get(result.probeId);
    if(!probe||probe.projectId!==projectId||probe.principal!==principal||probe.documentId!==input.documentId||result.documentId!==probe.documentId||result.nonce!==probe.nonce||result.stage!==probe.stage||probe.closed||probe.invalid||!probe.used||this.now()-probe.stageAt>25000)throw new Error('Browser capability stage is stale or unavailable');
    this.previews.assertSession(projectId,probe.sessionId);
    const protectedStage=probe.stage==='enforced',count=probe.records[probe.stage];
    if(result.error||result.peerOpened===protectedStage||result.peerDelivered===protectedStage||kinds.some(kind=>protectedStage?count[kind]!==0:count[kind]!==1)){probe.invalid=true;probe.closed=true;this.previews.close(projectId,probe.sessionId);throw new Error('Browser network isolation was not proven. Interactive preview remains disabled.');}
    const index=stages.indexOf(probe.stage);if(index<2){probe.stage=stages[index+1];probe.stageAt=this.now();probe.ticket=random();probe.nonce=probe.nonces[probe.stage];probe.used=false;return {step:this.step(probe)};}
    // Revocation of every probe document/host precedes a fresh distinct project host.
    probe.closed=true;this.previews.close(projectId,probe.sessionId);
    if(this.probes.size+this.views.size>=8)throw new Error('Browser preview capability capacity reached; wait for retained probes to expire');
    const session=this.previews.open(projectId,probe.processId),view:View={id:session.id,projectId,principal,documentId:probe.documentId,host:random()+'.localhost',port:probe.port,ticket:random(),used:false,expiresAt:Math.min(session.expiresAt,probe.expiresAt),probeId:probe.id,abort:new AbortController()};probe.viewId=view.id;this.views.set(view.id,view);
    return {view:{id:view.id,documentId:view.documentId,url:this.origin(view.host,view.port)+`/?__abyssus_boot=${view.ticket}`,expiresAt:view.expiresAt}};
  }
  close(projectId:string,principal:string,documentId:string,id:string){const view=this.views.get(id);if(view){if(view.projectId!==projectId||view.principal!==principal||view.documentId!==documentId)throw new Error('Browser preview ownership changed');this.dropView(view);return {closed:true};}const probe=this.probes.get(id);if(!probe||probe.projectId!==projectId||probe.principal!==principal||probe.documentId!==documentId)throw new Error('Browser preview is stale');probe.closed=true;probe.invalid=true;if(probe.viewId){const selected=this.views.get(probe.viewId);if(selected)this.dropView(selected);}try{this.previews.close(projectId,probe.sessionId);}catch{/* already revoked */}return {closed:true};}
  private dropView(view:View){view.abort.abort();this.views.delete(view.id);try{this.previews.close(view.projectId,view.id);}catch{/* expiry/stop already revoked */}}
  private sentinel(raw:string){const match=/^\/_preview-sentinel\/([a-f0-9-]{36})\/(positive|enforced|positiveAgain)\/(get|image|ws|redirect|navigation)\/([a-f0-9]{48})$/.exec(raw);if(!match)return;const probe=this.probes.get(match[1]);if(!probe||this.now()>probe.expiresAt||match[4]!==probe.nonces[match[2] as BrowserProbeStage]||stages.indexOf(match[2] as BrowserProbeStage)>stages.indexOf(probe.stage))return;const stage=browserProbeStage.parse(match[2]),kind=match[3] as typeof kinds[number];return {probe,stage,kind};}
  private invalidate(probe:Probe){probe.invalid=true;if(probe.viewId){const view=this.views.get(probe.viewId);if(view)this.dropView(view);}}
  private account(probe:Probe,rawHeaders:string[],target:string,responseBytes:number){const bytes=Buffer.byteLength(rawHeaders.join('\r\n'))+Buffer.byteLength(target);if(probe.requests>=64||probe.requestBytes+bytes>262144||probe.responseBytes+responseBytes>131072){this.invalidate(probe);throw new Error('Browser capability total budget exceeded');}probe.requests++;probe.requestBytes+=bytes;probe.responseBytes+=responseBytes;}
  private hit(probe:Probe,stage:BrowserProbeStage,kind:typeof kinds[number]){if(probe.records[stage][kind]>=2)this.invalidate(probe);else probe.records[stage][kind]++;if(stage==='enforced')this.invalidate(probe);}
  register(app:FastifyInstance){
    app.addHook('onRequest',async(request,reply)=>{
      const rawHost=request.headers.host??'',looksPreview=/\.localhost/i.test(rawHost),looksSentinel=request.url.startsWith('/_preview-sentinel/');if(!looksPreview&&!looksSentinel)return;
      const hostFields=request.raw.rawHeaders.filter((_,index)=>index%2===0).filter(name=>name.toLowerCase()==='host').length;
      if(hostFields!==1||request.raw.rawHeaders.length>128||Buffer.byteLength(request.raw.rawHeaders.join('\r\n'))>16384||rawHost.length>96)return reply.code(421).send('Preview host refused');
      if(looksSentinel&&!looksPreview){const value=this.sentinel(request.url);if(!value||rawHost!==`127.0.0.1:${value.probe.port}`||request.method!=='GET')return reply.code(421).send('Capability sentinel unavailable');try{this.account(value.probe,request.raw.rawHeaders,request.url,1024);}catch{return reply.code(429).send('Capability budget exhausted');}this.hit(value.probe,value.stage,value.kind);reply.headers({'Cache-Control':'no-store','Access-Control-Allow-Origin':'null','Content-Security-Policy':"default-src 'none'; sandbox"});if(value.kind==='image')return reply.type('image/png').send(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=','base64'));return reply.type(value.kind==='navigation'?'text/html':'text/plain').send(value.kind==='navigation'?'<!doctype html><title>Calibration target reached</title>':'calibration');}
      const match=/^([a-f0-9]{48}\.localhost):([1-9][0-9]{3,4})$/.exec(rawHost);if(!match)return reply.code(421).send('Preview host refused');
      this.prune();const probe=[...this.probes.values()].find(entry=>entry.host===match[1]&&entry.port===Number(match[2])&&!entry.closed),view=[...this.views.values()].find(entry=>entry.host===match[1]&&entry.port===Number(match[2]));
      if(!probe&&!view)return reply.code(421).send('Preview host unavailable');
      reply.header('Access-Control-Allow-Origin','null').header('Cache-Control','no-store');
      if(request.method!=='GET'||request.headers.authorization||request.headers.cookie||request.headers.origin&&request.headers.origin!=='null'||request.headers['transfer-encoding']||request.headers['content-length']&&request.headers['content-length']!=='0')return reply.code(403).send('Preview request refused');
      try{return await runNativeOperation(async()=>{
        if(probe){this.previews.assertSession(probe.projectId,probe.sessionId);if(probe.invalid||this.now()-probe.stageAt>25000)throw new Error('Capability stage unavailable');const origin=this.origin(probe.host,probe.port),sentinel=`http://127.0.0.1:${probe.port}/_preview-sentinel/${probe.id}/${probe.stage}`;
          if(request.url===`/redirect/${probe.stage}`){this.account(probe,request.raw.rawHeaders,request.url,4096);reply.headers(this.headers(origin,probe.port,probe.stage==='enforced',true,sentinel));return reply.code(302).header('Location',sentinel+'/redirect/'+probe.nonce).send();}
          if(probe.used||request.headers['sec-fetch-dest']!=='iframe'||request.url!==`/stage/${probe.stage}?ticket=${probe.ticket}`)return reply.code(403).send('Capability document ticket refused');probe.used=true;const step=this.step(probe);const document=probeDocument(step,origin,sentinel);this.account(probe,request.raw.rawHeaders,request.url,Buffer.byteLength(document)+4096);reply.headers(this.headers(origin,probe.port,probe.stage==='enforced',true,sentinel));return reply.type('text/html; charset=utf-8').send(document);
        }
        const selected=view!;this.previews.assertSession(selected.projectId,selected.id);const origin=this.origin(selected.host,selected.port);let target=request.url,documentLoad=false;const destination=request.headers['sec-fetch-dest'];if(typeof destination!=='string'||!['iframe','document','script','style','image','font','empty'].includes(destination))return reply.code(403).send('Preview fetch destination refused');
        if(request.headers['sec-fetch-dest']==='iframe'||request.headers['sec-fetch-dest']==='document'){
          if(selected.used||request.headers['sec-fetch-dest']!=='iframe'||target!==`/?__abyssus_boot=${selected.ticket}`)return reply.code(403).send('Preview document ticket refused');selected.used=true;documentLoad=true;target='/';
        }else if(!selected.used||request.url.includes('__abyssus_boot'))return reply.code(403).send('Preview document not admitted');
        target=previewPath.parse(target);const disconnected=new AbortController(),cancel=()=>disconnected.abort(),closed=()=>{if(!reply.raw.writableEnded)cancel();};request.raw.once('aborted',cancel);reply.raw.once('close',closed);let result;try{const abort=AbortSignal.any([selected.abort.signal,disconnected.signal,AbortSignal.timeout(Math.max(1,Math.min(28000,selected.expiresAt-this.now())))]);result=await this.previews.resource(selected.projectId,selected.id,target,abort);}finally{request.raw.off('aborted',cancel);reply.raw.off('close',closed);}this.prune();if(!this.views.has(selected.id)||selected.abort.signal.aborted)throw new Error('Preview revoked');if(result.contentType.startsWith('text/html')&&!documentLoad)return reply.code(403).send('Preview HTML subresource refused');reply.headers(this.headers(origin,selected.port));return reply.code(result.status).type(result.contentType).send(Buffer.from(result.body,'base64'));
      });}catch{return reply.code(410).header('Cache-Control','no-store').send('Preview unavailable. Reopen deliberately after checking the owned process.');}
    });
    app.server.on('upgrade',(request,socket)=>{const value=this.sentinel(request.url??'');if(value&&value.kind==='ws'&&request.headers.host===`127.0.0.1:${value.probe.port}`&&request.rawHeaders.filter((name,index)=>index%2===0&&name.toLowerCase()==='host').length===1&&request.rawHeaders.length<=128&&Buffer.byteLength(request.rawHeaders.join('\r\n'))<=16384){try{this.account(value.probe,request.rawHeaders,request.url??'',128);}catch{socket.destroy();return;}this.hit(value.probe,value.stage,'ws');socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');}else socket.destroy();});
  }
  shutdown(){this.closing=true;for(const view of this.views.values())this.dropView(view);for(const probe of this.probes.values()){probe.closed=true;probe.invalid=true;}this.probes.clear();}
}
