import {useEffect,useRef,useState} from 'react';
import type {ChatDetail,RecoveryDestination,RecoveryEntry,RecoveryView} from '../shared/types';
import {errorText,id,latestEventId,request} from './api';

const labels={completed:'Finished',failed:'Failed',not_started:'Not started',running:'Running · last recorded',uncertain:'Uncertain',interrupted:'Interrupted',unknown:'Unknown'};
const destinations={controls:'Review chat controls',approvals:'Review approvals',terminal:'Open command evidence',installs:'Open install recovery',plan:'Open plan and goal'};
export function recoveryFreshness(view:RecoveryView,detail:ChatDetail):boolean {
  return view.chatId===detail.chat.id && view.latestEventId===latestEventId(detail) && view.chat.status===detail.chat.status && view.chat.updatedAt===detail.chat.updatedAt && view.chat.mode===(detail.chat.mode??'execute') && view.chat.modeVersion===(detail.chat.modeVersion??0)
    && view.plan?.id===detail.plan.id && view.plan?.version===detail.plan.version && view.goal?.id===detail.goal?.id && view.goal?.revision===detail.goal?.revision && view.goal?.updatedAt===detail.goal?.updatedAt;
}
export function RecoveryContent({view,stale,onNavigate}:{view:RecoveryView;stale:boolean;onNavigate:(destination:RecoveryDestination,entry?:RecoveryEntry)=>void}) {
  const incomplete=view.coverage.some(item=>item.truncated||item.unavailable>0);
  return <>
    <p className="muted">Observed <time dateTime={view.observedAt}>{new Date(view.observedAt).toLocaleString()}</time>. Recorded state does not establish current process liveness. Opening this view runs no work.</p>
    {stale&&<p role="status">This observation may be stale. Refresh recovery; existing controls check current state when you act.</p>}
    <p>Chat: {view.chat.status.replaceAll('_',' ')} · {view.chat.mode} mode · version {view.chat.modeVersion}. <button className="text-button" onClick={()=>onNavigate('controls')}>Review Resume / pause controls</button></p>
    {view.goal&&<p>Goal: {view.goal.status.replaceAll('_',' ')} · revision {view.goal.revision} · {view.goal.eventId?`Event #${view.goal.eventId}`:'Original event unavailable'}. {view.goal.status==='completed'?'Existing runtime acceptance; unobserved requirements are not proven.':''} {view.goal.uncertainEventIds.length>0&&`Uncertain effect events: ${view.goal.uncertainEventIds.map(id=>'#'+id).join(', ')}.`} {view.goal.truncated&&'Goal evidence is incomplete.'} <button className="text-button" onClick={()=>onNavigate('plan')}>Review goal and original assignment</button></p>}
    {incomplete&&<p role="status">Some evidence is omitted or unavailable. Missing history never proves work finished or never started.</p>}
    {!view.entries.length&&<p>No operation evidence is available in this bounded view. Outcomes are unknown.</p>}
    <ol className="recovery-entries">{view.entries.map(entry=><li key={entry.id} className={`recovery-entry recovery-${entry.status}`}>
      <div><strong>{labels[entry.status]}</strong> <span>{entry.label.replaceAll('_',' ')}</span></div>
      <p>{entry.reason}</p>
      {entry.outputTruncated&&<p>Original command output is truncated. Missing output does not establish success or absence of effects.</p>}
      <p className="muted">{entry.updatedAt?<time dateTime={entry.updatedAt}>{new Date(entry.updatedAt).toLocaleString()}</time>:'Original timestamp unavailable'}{entry.evidence.map(event=><span key={event.eventId}> · Event #{event.eventId}{event.at?` (${new Date(event.at).toLocaleString()})`:''}</span>)}{entry.evidenceTruncated&&' · Earlier source IDs omitted'}</p>
      <details><summary>Original identities</summary><dl>{(['frameId','commandId','callId','processId','installId','generation'] as const).map(key=>entry[key]!==undefined&&<div key={key}><dt>{key}</dt><dd>{entry[key]}</dd></div>)}{entry.planStep&&<div><dt>Plan step</dt><dd>{entry.planStep.planId} / {entry.planStep.planVersion} / {entry.planStep.phaseId} / {entry.planStep.stepId}</dd></div>}</dl></details>
      <button className="text-button" onClick={()=>onNavigate(entry.destination,entry)}>{destinations[entry.destination]}</button>
    </li>)}</ol>
    <details><summary>Coverage and provenance</summary><p>Projection revision {view.revision}. This identifies an observation and cannot authorize an action.</p><p>Original human messages: {[...new Set([...view.humanMessageIds,...(view.goal?.humanMessageId?[view.goal.humanMessageId]:[])])].join(', ')||'Unavailable in retained run metadata'}.</p><ul>{view.coverage.map(item=><li key={item.source}>{item.source}: limit {item.limit}{item.truncated?' · truncated':''}{item.unavailable?` · ${item.unavailable} unavailable`:''}</li>)}</ul></details>
    <p className="muted">Inspect original outcomes before continuing. Resume cannot waive uncertain effects, replay a command or undo an install.</p>
  </>;
}
export function RecoveryPanel({detail,connected,onClose,onNavigate}:{detail:ChatDetail;connected:boolean;onClose:()=>void;onNavigate:(destination:RecoveryDestination,entry?:RecoveryEntry)=>void}) {
  const [view,setView]=useState<RecoveryView|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[aged,setAged]=useState(false);
  const generation=useRef(0),abort=useRef<AbortController|null>(null);
  const load=async()=>{
    const n=++generation.current;abort.current?.abort();const controller=new AbortController();abort.current=controller;setBusy(true);setError('');
    try{const next=await request<RecoveryView>(`/chats/${id(detail.chat.id)}/recovery`,{signal:controller.signal});if(n===generation.current&&!controller.signal.aborted&&next.chatId===detail.chat.id){setView(next);setAged(false);}}
    catch(e){if(n===generation.current&&!controller.signal.aborted)setError(errorText(e));}
    finally{if(n===generation.current)setBusy(false);}
  };
  useEffect(()=>{setView(null);void load();return()=>{generation.current++;abort.current?.abort();};},[detail.chat.id]);
  useEffect(()=>{if(!view)return;const timer=setTimeout(()=>setAged(true),30000);return()=>clearTimeout(timer);},[view]);
  return <section id="chat-recovery" className="chat-recovery" aria-label="Recovery" tabIndex={-1} onKeyDown={event=>{if(event.key==='Escape')onClose();}}>
    <header><h2>Recovery</h2><button className="text-button" disabled={busy} onClick={()=>void load()}>{busy?'Refreshing…':'Refresh recovery'}</button><button className="text-button" onClick={onClose}>Close recovery</button></header>
    <div className="recovery-scroll">{error&&<p role="alert">{error}</p>}{!view&&!error&&<p>Reading retained evidence…</p>}{view&&<RecoveryContent view={view} stale={aged||!connected||!recoveryFreshness(view,detail)} onNavigate={onNavigate}/>}</div>
  </section>;
}
