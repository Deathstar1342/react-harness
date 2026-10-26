import {useEffect,useRef,useState} from 'react';
import type {CheckpointList,CheckpointPreview} from '../shared/types';
import {request,post,id,errorText} from './api';
import {Modal} from './Modal';

export function CheckpointReview({preview,busy,confirmed,onConfirm,onRestore}:{preview:CheckpointPreview;busy:boolean;confirmed:boolean;onConfirm:(value:boolean)=>void;onRestore:()=>void}){
 return <section aria-label="Checkpoint restore preview"><h3>{preview.checkpoint.label}</h3>
  <p>Preview expires {new Date(preview.expiresAt).toLocaleTimeString()}.</p>
  <p>{preview.changes.length} file changes · {preview.checkpoint.files} captured files · {preview.currentExcludedCount} current excluded entries remain untouched.</p>
  <p>Review every change below. Restore replaces this project's included source files with the checkpoint, including removing files added since capture. Commands, installs, external services and conversations are not rolled back.</p>
  {preview.changes.map(change=><details key={change.path} open><summary>{change.kind} · {change.path}</summary><pre className="change-diff">{change.diff||'File mode change.'}</pre></details>)}
  {!preview.changes.length?<p>The included files already match this checkpoint.</p>:<>
   <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>onConfirm(event.target.checked)}/> Restore this reviewed file set</label>
   <button className="button" disabled={busy||!confirmed} onClick={onRestore}>{busy?'Restoring…':'Restore reviewed files'}</button>
  </>}
 </section>;
}
export function CheckpointsPanel({projectId,chatId,revision,onClose}:{projectId:string;chatId:string;revision:number;onClose:()=>void}){
 const [data,setData]=useState<CheckpointList>(),[preview,setPreview]=useState<CheckpointPreview>(),[label,setLabel]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[confirmed,setConfirmed]=useState(false),[refresh,setRefresh]=useState(0);
 const sequence=useRef(0),alive=useRef(true),currentRevision=useRef(revision);currentRevision.current=revision;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;sequence.current++;};},[]);
 useEffect(()=>{const controller=new AbortController();sequence.current++;setPreview(undefined);setConfirmed(false);setData(undefined);setError('');
  void request<CheckpointList>(`/projects/${id(projectId)}/checkpoints`,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setData(value);}).catch(e=>{if(!controller.signal.aborted)setError(errorText(e));});
  return()=>controller.abort();
 },[projectId,chatId,refresh]);
 useEffect(()=>{if(!busy){sequence.current++;setPreview(undefined);setConfirmed(false);}},[revision]);
 async function perform(action:()=>Promise<unknown>,select=false){if(busy)return;const current=++sequence.current,requestedRevision=currentRevision.current;setBusy(true);setError('');setConfirmed(false);setPreview(undefined);
  try{const result=await action();if(alive.current&&sequence.current===current){if(select){if(requestedRevision===currentRevision.current)setPreview(result as CheckpointPreview);else setError('Project files changed while loading this preview. Select the checkpoint again.');}else setRefresh(r=>r+1);}}
  catch(e){if(alive.current&&sequence.current===current)setError(errorText(e));}
  finally{if(alive.current)setBusy(false);}
 }
 return <Modal title="Checkpoints" titleId="checkpoints-title" className="changes-dialog" onClose={onClose} busy={busy}>
  <p>Capture a task boundary after pausing project work and saving editors. Checkpoints contain bounded source text; Git history, secrets, private state, dependencies and build outputs are excluded.</p>
  <div className="checkpoint-capture"><label>Checkpoint label <input value={label} maxLength={80} disabled={busy} onChange={e=>setLabel(e.target.value)}/></label><button className="button" disabled={busy||!data} onClick={()=>void perform(()=>post(`/projects/${id(projectId)}/checkpoints`,{chatId,label}))}>Capture checkpoint</button><button className="text-button" disabled={busy} onClick={()=>setRefresh(r=>r+1)}>Refresh checkpoints</button></div>
  {busy&&<p role="status">Updating checkpoints…</p>}
  {error&&<p role="alert">{error}</p>}
  {data&&<p className="muted">Up to {data.limits.files} files, {Math.round(data.limits.fileBytes/1024)} KiB each, {Math.round(data.limits.bytes/1024/1024)} MiB per capture. Old unreferenced captures are retained up to the storage limit; restore history stays protected.</p>}
  <div className="changes-layout"><nav aria-label="Saved checkpoints">{data?.items.map(item=><section key={item.id}><button className="change-file" disabled={busy} onClick={()=>void perform(()=>post(`/projects/${id(projectId)}/checkpoints/${id(item.id)}/preview`,{chatId}),true)}>{item.label}<small>{new Date(item.createdAt).toLocaleString()} · {item.files} files</small></button><details><summary>{item.excludedCount} excluded entries</summary><ul>{item.excluded.map(entry=><li key={entry.path}>{entry.path} · {entry.reason}</li>)}</ul>{item.excludedCount>item.excluded.length&&<p>Additional excluded entries are counted but omitted from this bounded list.</p>}</details></section>)}{data&&!data.items.length&&<p>No checkpoints yet.</p>}</nav>
  <div className="changes-review">{preview?<CheckpointReview preview={preview} busy={busy} confirmed={confirmed} onConfirm={setConfirmed} onRestore={()=>{if(confirmed)void perform(()=>post(`/projects/${id(projectId)}/checkpoints/${id(preview.checkpoint.id)}/restore`,{chatId,previewToken:preview.previewToken,revision:preview.revision,confirmation:'restore-files'}));}}/>:<p>Select a checkpoint for a fresh restore preview.</p>}</div></div>
  {!!data?.restores.length&&<details><summary>File restore history</summary>{data.restores.map(restore=><p key={restore.id}>{new Date(restore.createdAt).toLocaleString()} · {restore.files} files · <strong>{restore.status}</strong>{restore.status!=='done'?' — retained uncertainty blocks project changes; this restore cannot replay.':''}</p>)}</details>}
 </Modal>;
}
