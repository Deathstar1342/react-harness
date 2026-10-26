import {useEffect,useRef,useState} from 'react';
import {flushSync} from 'react-dom';
import {browserProbeResult,browserProbeStep,browserPreviewView,type BrowserProbeStep,type BrowserProbeResult} from '../shared/browser-preview';
import {errorText,id,post,request} from './api';
export interface BrowserPreviewControl {close:()=>Promise<void>}
function safeURL(raw:string,probe:boolean){const url=new URL(raw);if(url.protocol!=='http:'||!/^([a-f0-9]{48})\.localhost$/.test(url.hostname)||!/^\d{4,5}$/.test(url.port)||url.username||url.password||url.hash||!(probe?/^\/stage\/(positive|enforced|positiveAgain)\?ticket=[a-f0-9]{48}$/.test(url.pathname+url.search):/^\/\?__abyssus_boot=[a-f0-9]{48}$/.test(url.pathname+url.search)))throw new Error('Preview capability URL refused');return raw;}

export function BrowserPreviewSurface({projectId,processId,onControl,onError,onReady}:{projectId:string;processId:string;onControl:(value:BrowserPreviewControl|undefined)=>void;onError:(message:string)=>void;onReady:()=>void}){
 const [surface,setSurface]=useState<{url:string;probe:boolean}>(),[message,setMessage]=useState('Checking browser isolation before loading project content…');const iframe=useRef<HTMLIFrameElement>(null);
 useEffect(()=>{
  const documentId=crypto.randomUUID(),abort=new AbortController(),totalDeadline=Date.now()+120000;const scope=()=>AbortSignal.any([abort.signal,AbortSignal.timeout(Math.max(1,Math.min(25000,totalDeadline-Date.now())))]);let stopped=false,probeId:string|undefined,viewId:string|undefined,waiter:{step:BrowserProbeStep;resolve:(result:BrowserProbeResult)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;messages:number}|undefined,closing:Promise<void>|undefined,expiry:ReturnType<typeof setTimeout>|undefined;
  const remoteClose=async()=>{if(!probeId&&!viewId)return;try{await request(`/projects/${id(projectId)}/previews/${id(probeId??viewId!)}/browser-close`,{method:'POST',body:JSON.stringify({documentId}),signal:AbortSignal.timeout(3000),keepalive:true});}catch{/* restart/expiry already revokes old hosts; no adoption or replay */}};
  const close=()=>closing??=(async()=>{stopped=true;abort.abort();if(expiry)clearTimeout(expiry);if(waiter){clearTimeout(waiter.timer);waiter.reject(new Error('Preview closed'));waiter=undefined;}window.removeEventListener('message',receive);await remoteClose();})();
  const receive=(event:MessageEvent)=>{
   const expected=waiter;if(stopped||!expected||event.source!==iframe.current?.contentWindow||event.origin!=='null')return;
   if(++expected.messages>16){expected.reject(new Error('Capability message bound exceeded'));return;}
   const parsed=browserProbeResult.safeParse(event.data);if(!parsed.success)return;const result=parsed.data;
   if(result.probeId!==expected.step.id||result.documentId!==documentId||result.nonce!==expected.step.nonce||result.stage!==expected.step.stage)return;
   clearTimeout(expected.timer);waiter=undefined;expected.resolve(result);
  };
  window.addEventListener('message',receive);onControl({close});
  const pagehide=()=>{void close();};const pageshow=(event:PageTransitionEvent)=>{if(event.persisted){setSurface(undefined);setMessage('Reopen preview to check this restored browser document.');void close();}};window.addEventListener('pagehide',pagehide);window.addEventListener('pageshow',pageshow);
  const stage=(step:BrowserProbeStep)=>new Promise<BrowserProbeResult>((resolve,reject)=>{if(stopped)return reject(new Error('Preview closed'));const timer=setTimeout(()=>reject(new Error('Browser capability timed out; interactive preview stays disabled')),Math.max(1,Math.min(22000,totalDeadline-Date.now())));waiter={step,resolve,reject,timer,messages:0};setSurface({url:safeURL(step.url,true),probe:true});});
  void (async()=>{
   let step=browserProbeStep.parse(await request(`/projects/${id(projectId)}/previews/${id(processId)}/browser-probe`,{method:'POST',body:JSON.stringify({documentId}),signal:scope()}));probeId=step.id;if(stopped){await remoteClose();return;}
   const order=['positive','enforced','positiveAgain'];
   for(let index=0;index<3;index++){
    if(step.stage!==order[index]||step.documentId!==documentId||step.id!==probeId)throw new Error('Capability stage changed');setMessage(index===1?'Verifying network denial…':'Calibrating this browser session…');
    const result=await stage(step);await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,1100);abort.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('Preview closed'));},{once:true});});
    if(stopped)return;flushSync(()=>setSurface(undefined)); // all probe frames gone before terminal advance
    const next=await request<{step?:unknown;view?:unknown}>(`/projects/${id(projectId)}/previews/browser-advance`,{method:'POST',body:JSON.stringify({documentId,result}),signal:scope()});
    if(stopped){await remoteClose();return;}
    if(index<2){if(!next.step||next.view)throw new Error('Capability stages incomplete');step=browserProbeStep.parse(next.step);}
    else{if(!next.view||next.step)throw new Error('Capability proof incomplete');const view=browserPreviewView.parse(next.view);if(view.documentId!==documentId)throw new Error('Preview document changed');viewId=view.id;setSurface({url:safeURL(view.url,false),probe:false});setMessage('Isolated project preview · manual Reload');expiry=setTimeout(()=>{setSurface(undefined);setMessage('Preview expired. Reopen to check this browser again.');void close();},Math.max(1,view.expiresAt-Date.now()));}
   }
  })().catch(error=>{if(!stopped){setSurface(undefined);setMessage('Interactive preview is disabled for this session.');onError(errorText(error));void close();}});
  return()=>{window.removeEventListener('pagehide',pagehide);window.removeEventListener('pageshow',pageshow);void close();onControl(undefined);};
 },[projectId,processId]);
 return <div className="browser-preview-surface"><p role="status">{message}</p>{surface&&<iframe key={surface.url} ref={iframe} sandbox="allow-scripts" referrerPolicy="no-referrer" title={surface.probe?'Trusted browser isolation check':'Isolated project preview'} src={surface.url} onLoad={()=>{if(!surface.probe)onReady();}}/>}</div>;
}
