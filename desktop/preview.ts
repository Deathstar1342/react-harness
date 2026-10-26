import {WebContentsView,session,type BrowserWindow,type Session} from 'electron';
import {createServer,type Server} from 'node:net';
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {previewPath} from '../shared/preview-policy.js';
import type {BackendTarget} from './proxy.js';
import type {PreviewSession} from '../shared/types.js';

export const previewScheme={scheme:'abyssus-preview',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,allowServiceWorkers:false}};
const rectangle=z.strictObject({x:z.number().int().min(0).max(10000),y:z.number().int().min(0).max(10000),width:z.number().int().min(40).max(10000),height:z.number().int().min(40).max(10000)});
export const previewOpenInput=z.strictObject({projectId:z.uuid(),processId:z.uuid(),requestId:z.uuid(),sessionId:z.string().min(1).max(200),bounds:rectangle});
export const previewControlInput=z.strictObject({requestId:z.uuid(),sessionId:z.string().min(1).max(200)});
export const previewBoundsInput=previewControlInput.extend({bounds:rectangle});
const viewSchema=z.strictObject({id:z.uuid(),projectId:z.uuid(),processId:z.uuid(),chatId:z.uuid(),generation:z.number().int().nonnegative(),expiresAt:z.number().int().positive()});
const resourceSchema=z.strictObject({status:z.number().int().min(200).max(599).refine(status=>status<300||status>=400),contentType:z.string().max(128).regex(/^(?:text\/(?:html|plain|css|javascript)|application\/(?:javascript|json|wasm|font-woff)|image\/(?:png|jpeg|gif|webp|svg\+xml|x-icon)|font\/(?:woff2?|ttf|otf))(?:; charset=utf-8)?$/),body:z.string().max(5592408)});
interface Active {requestId:string;epoch:number;backend:BackendTarget;view:PreviewSession;origin:string;partition:Session;contents?:WebContentsView;sink?:Server;abort:AbortController;pending:Set<Promise<unknown>>;running:number;queue:(()=>void)[];closing?:Promise<void>;expired?:ReturnType<typeof setTimeout>}
export function previewCSP(origin:string){return `default-src 'none'; script-src ${origin} 'unsafe-inline'; style-src ${origin} 'unsafe-inline'; img-src ${origin} data:; font-src ${origin}; connect-src ${origin}; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-scripts allow-same-origin`;}
export function previewURL(raw:string,origin:string){try{const url=new URL(raw);return url.protocol==='abyssus-preview:'&&url.host===new URL(origin).host&&!url.username&&!url.password&&!url.port&&raw.startsWith(origin+'/')&&previewPath.safeParse(url.pathname+url.search).success;}catch{return false;}}
/** Native-only untrusted surface. App IPC passes identities/bounds, never URLs. */
export class NativePreview {
  private active?:Active;
  private epoch=0;
  private requestId?:string;
  private requestSession?:string;
  private stopping=false;
  constructor(private owner:()=>BrowserWindow|undefined,private backend:()=>BackendTarget|undefined,private documentSession:()=>string|undefined){}
  private target(sessionId:string){const target=this.backend();if(this.stopping||!target||!target.sessionId||target.sessionId!==sessionId||this.documentSession()!==sessionId)throw new Error('Preview backend session changed');return target;}
  private current(active:Active){if(active.abort.signal.aborted||this.active!==active||this.epoch!==active.epoch||this.requestId!==active.requestId||Date.now()>=active.view.expiresAt)throw new Error('Preview session is stale');if(this.target(active.backend.sessionId!)!==active.backend){const current=this.target(active.backend.sessionId!);if(current.address!==active.backend.address||current.token!==active.backend.token)throw new Error('Preview backend changed');}}
  private bounds(input:z.infer<typeof rectangle>){const owner=this.owner();if(!owner||owner.isDestroyed())throw new Error('Preview owner is unavailable');const [width,height]=owner.getContentSize();if(input.x+input.width>width||input.y+input.height>height)throw new Error('Preview panel bounds are stale');return input;}
  private async post(target:BackendTarget,route:string,body:unknown,signal?:AbortSignal):Promise<unknown>{
    const address=new URL(target.address);if(address.protocol!=='http:'||address.hostname!=='127.0.0.1'||address.username||address.password||address.pathname!=='/')throw new Error('Preview controller target refused');
    const abort=AbortSignal.any([AbortSignal.timeout(35000),...(signal?[signal]:[])]);
    const result=await fetch(target.address.replace(/\/$/,'')+route,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${target.token}`,'content-type':'application/json'},body:JSON.stringify(body),signal:abort});
    const reader=result.body?.getReader(),parts:Uint8Array[]=[];let size=0;
    if(!reader)throw new Error('Preview controller response missing');
    try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>6*1024*1024){void reader.cancel();throw new Error('Preview controller response limit');}parts.push(item.value);}}finally{reader.releaseLock();}
    if(!result.ok||!result.headers.get('content-type')?.startsWith('application/json'))throw new Error('Preview controller refused the current process');
    return JSON.parse(Buffer.concat(parts,size).toString('utf8'));
  }
  private route(active:Active,suffix:string){return `/api/projects/${active.view.projectId}/previews/${active.view.id}/${suffix}`;}
  async open(raw:unknown){
    const input=previewOpenInput.parse(raw),target=this.target(input.sessionId),epoch=++this.epoch;this.requestId=input.requestId;this.requestSession=input.sessionId;
    await this.dispose(this.active);if(epoch!==this.epoch||this.requestId!==input.requestId)throw new Error('Preview selection changed');
    const view=viewSchema.parse(await this.post(target,`/api/projects/${input.projectId}/previews/${input.processId}/open`,{}));
    if(view.projectId!==input.projectId||view.processId!==input.processId)throw new Error('Preview process response changed');
    const active:Active={requestId:input.requestId,epoch,backend:target,view,origin:'abyssus-preview://'+randomBytes(24).toString('hex'),partition:session.fromPartition('preview-'+randomBytes(24).toString('hex'),{cache:false}),abort:new AbortController(),pending:new Set(),running:0,queue:[]};
    if(epoch!==this.epoch||this.requestId!==input.requestId){await this.dispose(active);throw new Error('Preview selection changed');}
    this.active=active;
    try{
      const sink=createServer(socket=>socket.destroy());active.sink=sink;sink.maxConnections=32;await new Promise<void>((resolve,reject)=>{sink.once('error',reject);sink.listen(0,'127.0.0.1',()=>{sink.off('error',reject);resolve();});});sink.on('error',()=>{active.abort.abort();void this.dispose(active).catch(()=>{});});
      const address=sink.address();if(!address||typeof address==='string')throw new Error('Preview network sink unavailable');
      await active.partition.setProxy({mode:'fixed_servers',proxyRules:`socks5://127.0.0.1:${address.port}`,proxyBypassRules:'<-loopback>'});this.current(active);
      active.partition.setPermissionRequestHandler((_contents,_permission,done)=>done(false));active.partition.setPermissionCheckHandler(()=>false);active.partition.on('will-download',event=>event.preventDefault());
      active.partition.webRequest.onBeforeRequest((details,done)=>{let allowed=false;try{this.current(active);const owner=active.contents?.webContents;allowed=!!owner&&!owner.isDestroyed()&&details.webContentsId===owner.id&&(!details.frame||details.frame===owner.mainFrame)&&previewURL(details.url,active.origin);}catch{/* deny */}done({cancel:!allowed});});
      active.partition.protocol.handle('abyssus-preview',request=>{
        const response=this.response(active,request);active.pending.add(response);void response.finally(()=>active.pending.delete(response)).catch(()=>{});return response;
      });
      const contents=new WebContentsView({webPreferences:{session:active.partition,sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInWorker:false,webviewTag:false,webSecurity:true,allowRunningInsecureContent:false,devTools:false,backgroundThrottling:false}});active.contents=contents;
      contents.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');contents.webContents.setWindowOpenHandler(()=>({action:'deny'}));contents.webContents.on('will-navigate',event=>event.preventDefault());contents.webContents.on('will-redirect',event=>event.preventDefault());contents.webContents.on('will-attach-webview',event=>event.preventDefault());contents.webContents.on('render-process-gone',()=>{active.abort.abort();void this.dispose(active).catch(()=>{});});
      this.current(active);this.owner()!.contentView.addChildView(contents);contents.setBounds(this.bounds(input.bounds));
      active.expired=setTimeout(()=>{active.abort.abort();void this.dispose(active).catch(()=>{});},Math.max(1,view.expiresAt-Date.now()));
      await contents.webContents.loadURL(active.origin+'/');this.current(active);return {previewId:view.id,requestId:input.requestId};
    }catch{await this.dispose(active);throw new Error('Isolated preview could not open. Inspect the owned process, then reload deliberately.');}
  }
  private async response(active:Active,request:Request):Promise<Response>{
    try{
      this.current(active);if(request.method!=='GET'||!previewURL(request.url,active.origin))return new Response(null,{status:403});
      if(active.running>=2){if(active.queue.length>=32)return new Response(null,{status:429});await new Promise<void>(resolve=>active.queue.push(resolve));}
      this.current(active);active.running++;
      try{
        const url=new URL(request.url),signal=AbortSignal.any([active.abort.signal,request.signal]);
        const result=resourceSchema.parse(await this.post(active.backend,this.route(active,'resource'),{path:previewPath.parse(url.pathname+url.search)},signal));this.current(active);
        const bytes=Buffer.from(result.body,'base64');if(bytes.length>4*1024*1024||bytes.toString('base64')!==result.body)throw new Error('Preview bytes refused');
        return new Response(result.status===204||result.status===205?null:bytes,{status:result.status,headers:{'Content-Type':result.contentType,'Content-Security-Policy':previewCSP(active.origin),'Cache-Control':'no-store, max-age=0','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin','Cross-Origin-Opener-Policy':'same-origin','Permissions-Policy':'camera=(), microphone=(), geolocation=(), usb=(), serial=(), payment=(), display-capture=()'}});
      }finally{active.running--;active.queue.shift()?.();}
    }catch{return new Response('Preview unavailable. Inspect the process and reload deliberately.',{status:503,headers:{'Content-Type':'text/plain','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; sandbox"}});}
  }
  move(raw:unknown){const input=previewBoundsInput.parse(raw),active=this.active;this.target(input.sessionId);if(!active||active.requestId!==input.requestId)throw new Error('Preview panel changed');this.current(active);active.contents?.setBounds(this.bounds(input.bounds));return {ok:true};}
  reload(raw:unknown){const input=previewControlInput.parse(raw),active=this.active;this.target(input.sessionId);if(!active||active.requestId!==input.requestId)throw new Error('Preview panel changed');this.current(active);active.contents?.webContents.reload();return {ok:true};}
  async close(raw:unknown){const input=previewControlInput.parse(raw);if(this.requestId!==input.requestId)return {closed:true};if(this.requestSession!==input.sessionId)throw new Error('Preview document session changed');this.epoch++;this.requestId=undefined;await this.dispose(this.active);return {closed:true};}
  private dispose(active:Active|undefined):Promise<void>{
    if(!active)return Promise.resolve();if(active.closing)return active.closing;
    active.abort.abort();if(active.expired)clearTimeout(active.expired);for(const wake of active.queue.splice(0))wake();
    return active.closing=(async()=>{
      // Keep the proxy and deny handlers alive through exact contents/network destruction.
      const contents=active.contents?.webContents;if(contents&&!contents.isDestroyed()){
        const destroyed=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Preview contents did not drain')),5000);contents.once('destroyed',()=>{clearTimeout(timer);resolve();});});
        try{this.owner()?.contentView.removeChildView(active.contents!);}catch{/* owner may already be gone */}contents.close({waitForBeforeUnload:false});await destroyed;
      }
      await Promise.allSettled([...active.pending]);await active.partition.closeAllConnections();await active.partition.clearStorageData();await active.partition.clearCache();
      if(active.sink?.listening)await new Promise<void>((resolve,reject)=>active.sink!.close(error=>error?reject(error):resolve()));
      try{await this.post(active.backend,this.route(active,'close'),{},AbortSignal.timeout(3000));}catch{/* backend revocation/expiry never adopts or replays anything */}
      if(this.active===active)this.active=undefined;
    })();
  }
  async drain(){this.epoch++;this.requestId=undefined;await this.dispose(this.active);}
  async shutdown(){this.stopping=true;await this.drain();}
}
