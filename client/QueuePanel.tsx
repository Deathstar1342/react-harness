import {useEffect,useRef,useState} from 'react';
import type {QueueView} from '../shared/types';
import {request,post,id,errorText} from './api';
import {Modal} from './Modal';
export function QueuePanel({projectId,onClose,onChat}:{projectId:string;onClose:()=>void;onChat:(chatId:string)=>void}){
 const [data,setData]=useState<QueueView>(),[text,setText]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[draft,setDraft]=useState<{taskId:string;text:string;revision:number}>();
 const alive=useRef(true),sequence=useRef(0),busyRef=useRef(false),projectRef=useRef(projectId);projectRef.current=projectId;
 async function load(signal?:AbortSignal){const seq=++sequence.current,project=projectId;let v=await request<QueueView>(`/projects/${id(project)}/queue`,{signal});const entries=[...v.entries];let cursor=v.nextCursor;while(cursor){const page=await request<QueueView>(`/projects/${id(project)}/queue?cursor=${encodeURIComponent(cursor)}`,{signal});if(page.revision!==v.revision)throw Error('Queue changed. Reload before continuing.');entries.push(...page.entries);cursor=page.nextCursor;}if(alive.current&&projectRef.current===project&&sequence.current===seq){setData({...v,entries});}}
 useEffect(()=>{alive.current=true;setData(undefined);setDraft(undefined);setError('');const controller=new AbortController();void load(controller.signal).catch(e=>{if(!controller.signal.aborted)setError(errorText(e));});const timer=setInterval(()=>{if(!busyRef.current)void load(controller.signal).catch(e=>{if(!controller.signal.aborted&&alive.current)setError(errorText(e));});},1000);return()=>{alive.current=false;controller.abort();clearInterval(timer);sequence.current++;};},[projectId]);
 async function perform(action:()=>Promise<unknown>,after?:()=>void){if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');try{await action();if(alive.current){after?.();await load();}}catch(e){if(alive.current)setError(errorText(e));}finally{busyRef.current=false;if(alive.current)setBusy(false);}}
 const edit=(body:unknown)=>request(`/projects/${id(projectId)}/queue`,{method:'PATCH',body:JSON.stringify(body)});
 function move(taskId:string,delta:number){if(!data)return;const order=data.entries.map(t=>t.id),from=order.indexOf(taskId),to=from+delta;if(to<0||to>=order.length)return;[order[from],order[to]]=[order[to],order[from]];void perform(()=>edit({action:'reorder',expectedRevision:data.revision,order}));}
 return <Modal title="Task queue" titleId="queue-title" className="changes-dialog queue-dialog" onClose={onClose} busy={busy}>
  <p>Write tasks in your own words, review their order, then Start. Each task keeps the normal approval and completion checks. Restart leaves the queue paused.</p>
  {error&&<p role="alert">{error}</p>}
  <div className="queue-controls"><button className="button primary" disabled={busy||!data||!data.startScope.length||data.status==='running'||!!data.activeTaskId||data.entries.some(t=>t.status==='stopped')} onClick={()=>{if(data)void perform(()=>post(`/projects/${id(projectId)}/queue/start`,{expectedRevision:data.revision,scope:data.startScope}));}}>Start task queue</button>
   <button className="button" disabled={busy||!data||data.status!=='running'} onClick={()=>{if(data)void perform(()=>edit({action:'pause',expectedRevision:data.revision}));}}>Pause queue</button>
   <button className="text-button" disabled={busy} onClick={()=>void perform(()=>load())}>Reload queue</button></div>
  {data&&<p role="status"><strong>{data.status}</strong> · {data.reason}</p>}
  <label className="queue-compose">New task<textarea aria-label="New queue task" value={text} maxLength={16000} disabled={busy} onChange={e=>setText(e.target.value)} rows={3}/></label>
  <button className="button" disabled={busy||!data||!text.trim()||data.total>=32} onClick={()=>{if(data)void perform(()=>edit({action:'add',text,expectedRevision:data.revision}),()=>setText(''));}}>Add task</button>
  <ol className="queue-tasks">{data?.entries.map((task,index)=><li key={task.id} data-queue-task={task.id}>
   <div><strong>Task {index+1} · {task.status}</strong>{task.chatId&&<button className="text-button" onClick={()=>onChat(task.chatId!)}>Open task conversation</button>}</div>
   <p className="queue-text">{task.text}</p><small>{task.reason}</small>
   {task.status==='pending'&&<div className="queue-controls"><button className="text-button" aria-label={`Move task ${index+1} up`} disabled={busy||index===0} onClick={()=>move(task.id,-1)}>Move up</button><button className="text-button" aria-label={`Move task ${index+1} down`} disabled={busy||index===data.entries.length-1} onClick={()=>move(task.id,1)}>Move down</button><button className="text-button" disabled={busy} onClick={()=>setDraft({taskId:task.id,text:task.text,revision:data.revision})}>Edit task</button><button className="text-button" disabled={busy} onClick={()=>void perform(()=>edit({action:'cancel',taskId:task.id,expectedRevision:data.revision}))}>Cancel pending task</button></div>}
   {task.status==='running'&&task.chatId&&<button className="button" disabled={busy} onClick={()=>void perform(()=>post(`/projects/${id(projectId)}/queue/cancel-active`,{taskId:task.id,chatId:task.chatId,expectedRevision:data.revision}))}>Cancel active task</button>}
  </li>)}</ol>
  {data&&!data.entries.length&&<p>No tasks yet. Adding a task does not run it.</p>}
  {draft&&<section aria-label="Edit queue task"><label>Task text<textarea aria-label="Edit queue task text" rows={4} value={draft.text} maxLength={16000} disabled={busy} onChange={e=>setDraft({...draft,text:e.target.value})}/></label><button className="button" disabled={busy||!draft.text.trim()} onClick={()=>void perform(()=>edit({action:'edit',taskId:draft.taskId,text:draft.text,expectedRevision:draft.revision}),()=>setDraft(undefined))}>Save task revision</button><button className="text-button" disabled={busy} onClick={()=>setDraft(undefined)}>Discard task edit</button></section>}
  <p className="muted">Pause stops future tasks and lets the active task finish. Cancel active task interrupts only its exact conversation. Stopped or unresolved claims cannot be skipped or replayed. Up to 32 retained tasks; 16,000 UTF-8 bytes per submission.</p>
 </Modal>;
}
