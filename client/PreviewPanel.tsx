import {BrowserPreviewSurface,type BrowserPreviewControl} from './BrowserPreviewSurface';
import {useEffect,useRef,useState} from 'react';
import type {PreviewEntry} from '../shared/types';
import {errorText,id,post,request} from './api';

/** Native view is owned by trusted main; this panel never receives its URL/token. */
export function PreviewPanel({projectId,revision,connected,onClose}:{projectId:string;revision:number;connected:boolean;onClose:()=>void}){
  const [entries,setEntries]=useState<PreviewEntry[]>([]),[selected,setSelected]=useState(''),[opened,setOpened]=useState<string>(),[supported,setSupported]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[browserRevision,setBrowserRevision]=useState(0);
  const area=useRef<HTMLDivElement>(null),control=useRef<{requestId:string;sessionId:string}|undefined>(undefined),browserControl=useRef<BrowserPreviewControl|undefined>(undefined);
  const bridge=window.abyssusDesktop;
  const refresh=async(signal?:AbortSignal)=>{const result=await request<{entries:PreviewEntry[];browserSupported:boolean}>(`/projects/${id(projectId)}/previews`,{signal});setEntries(result.entries);if(!bridge)setSupported(result.browserSupported);setSelected(value=>result.entries.some(entry=>entry.processId===value)?value:result.entries.find(entry=>entry.status==='starting'||entry.status==='ready')?.processId??result.entries.at(-1)?.processId??'');};
  useEffect(()=>{let live=true;void bridge?.status().then(status=>{if(live)setSupported(status.runtime==='container'&&typeof bridge.previewOpen==='function');}).catch(()=>{});return()=>{live=false;};},[bridge]);
  useEffect(()=>{const abort=new AbortController();void refresh(abort.signal).catch(e=>{if(!abort.signal.aborted)setError(errorText(e));});return()=>abort.abort();},[projectId,revision]);
  useEffect(()=>{
    if(!opened||!bridge||!supported||!area.current)return;
    let cancelled=false,resize:ResizeObserver|undefined;const requestId=crypto.randomUUID();let sessionId:string|undefined;
    const bounds=()=>{const rect=area.current!.getBoundingClientRect();const x=Math.max(0,Math.round(rect.x)),y=Math.max(0,Math.round(rect.y)),width=Math.min(Math.round(rect.width),window.innerWidth-x),height=Math.min(Math.round(rect.height),window.innerHeight-y);if(width<40||height<40)throw new Error('Scroll the preview panel into view before opening it');return {x,y,width,height};};
    const move=()=>{if(cancelled||!sessionId)return;try{void bridge.previewBounds({requestId,sessionId,bounds:bounds()}).catch(()=>{});}catch{void bridge.previewClose({requestId,sessionId}).catch(()=>{});setOpened(undefined);}};
    setBusy(true);setError('');
    void (async()=>{const status=await bridge.status();sessionId=status.sessionId;if(!sessionId||status.runtime!=='container')throw new Error('Open the container workspace first');if(cancelled)return;control.current={requestId,sessionId};await bridge.previewOpen({projectId,processId:opened,requestId,sessionId,bounds:bounds()});if(cancelled){await bridge.previewClose({requestId,sessionId});return;}resize=new ResizeObserver(move);resize.observe(area.current!);window.addEventListener('resize',move);document.addEventListener('scroll',move,true);await refresh();})().catch(e=>{if(!cancelled){setError(errorText(e));setOpened(undefined);}}).finally(()=>{if(!cancelled)setBusy(false);});
    return()=>{cancelled=true;resize?.disconnect();window.removeEventListener('resize',move);document.removeEventListener('scroll',move,true);if(control.current?.requestId===requestId)control.current=undefined;if(sessionId)void bridge.previewClose({requestId,sessionId}).catch(()=>{});};
  },[opened,projectId,supported,bridge]);
  const closeView=async()=>{const current=control.current;setOpened(undefined);if(current&&bridge)await bridge.previewClose(current);if(!bridge)await browserControl.current?.close();};
  const reload=async()=>{const current=control.current;if(!bridge){await browserControl.current?.close();setBrowserRevision(value=>value+1);return;}if(!current)return;setError('');try{await bridge.previewReload(current);await refresh();}catch(e){setError(errorText(e));}};
  const stop=async()=>{const entry=entries.find(entry=>entry.processId===selected);if(!entry)return;setBusy(true);setError('');try{await closeView();await post(`/chats/${id(entry.chatId)}/processes/${id(entry.processId)}/cancel`,{});await refresh();}catch(e){setError(errorText(e));}finally{setBusy(false);}};
  const chosen=entries.find(entry=>entry.processId===selected);
  return <section className="project-preview" aria-label="Live project preview">
    <header><strong>Project preview</strong><button className="icon-button" onClick={onClose} aria-label="Close preview panel">×</button></header>
    <p className="muted">Preview uses the project’s already approved server. HTTP GET and manual Reload only; HMR, WebSocket, forms and POST are unavailable.</p>
    {!supported&&<p role="status">Interactive preview requires an isolated native view or a proven same-port browser listener. Browser preview is disabled because this listener has no verified browser binding.</p>}
    {error&&<p role="alert">{error}</p>}
    {!entries.length?<p>No preview server recorded. Ask the coder to start the development server with its preview port through the normal approval flow.</p>:<>
      <label>Owned server<select value={selected} disabled={busy} onChange={event=>{void closeView().catch(e=>setError(errorText(e)));setSelected(event.target.value);}}>{entries.map(entry=><option value={entry.processId} key={entry.processId}>Port {entry.port} · {entry.status} · {entry.processId.slice(0,8)}</option>)}</select></label>
      {chosen&&<p role="status">{chosen.status}: {chosen.reason}</p>}
      <div className="preview-controls"><button className="button" disabled={!supported||!connected||busy||!chosen||!['starting','ready','failed'].includes(chosen.status)} onClick={()=>setOpened(selected)}>{busy?'Opening…':'Open preview'}</button><button className="button" disabled={!opened||busy||!connected} onClick={()=>void reload()}>Reload preview</button><button className="button" disabled={!opened||busy} onClick={()=>void closeView().catch(e=>setError(errorText(e)))}>Close view</button><button className="button" disabled={!chosen||busy||!connected||['stopped','uncertain','interrupted'].includes(chosen.status)} onClick={()=>void stop()}>Stop server</button><button className="text-button" disabled={busy} onClick={()=>void refresh().catch(e=>setError(errorText(e)))}>Refresh status</button></div>
      <p className="muted">Closing the view leaves the server running. Stop server waits for its owned worker cleanup; completed effects remain.</p>
    </>}
    {bridge?<div ref={area} className="preview-native-area" aria-label="Isolated native preview area">{!opened&&<span>Open an owned server to preview its UI here.</span>}</div>:opened&&<BrowserPreviewSurface key={opened+browserRevision} projectId={projectId} processId={opened} onControl={value=>{browserControl.current=value;}} onError={setError} onReady={()=>void refresh().catch(e=>setError(errorText(e)))}/>}
  </section>;
}
