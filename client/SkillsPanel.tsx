import {useEffect,useRef,useState} from 'react';
import type {SkillCatalog,SkillDocument,SkillDraft,SkillSelectionView,SkillWritePreview} from '../shared/types';
import {post,request,errorText} from './api';
import {Modal} from './Modal';

type View={catalog:SkillCatalog;selection:SkillSelectionView;drafts:SkillDraft[]};
export function SkillsPanel({chatId,projectId,planOnly,onClose,onChange,onDirty}:{chatId:string;projectId:string;planOnly:boolean;onClose:()=>void;onChange:()=>void;onDirty:(dirty:boolean)=>void}) {
  const [view,setView]=useState<View>(),[document,setDocument]=useState<SkillDocument>(),[name,setName]=useState(''),[description,setDescription]=useState(''),[body,setBody]=useState(''),[content,setContent]=useState(''),[base,setBase]=useState(''),[preview,setPreview]=useState<SkillWritePreview>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[discard,setDiscard]=useState(false);
  const owner=useRef(crypto.randomUUID()),dirty=content!==base;
  const mounted=useRef(true),controller=useRef(new AbortController());
  const formDirty=!content&&!!(name||description||body),allDirty=dirty||formDirty;
  const [outcome,setOutcome]=useState('');
  useEffect(()=>{mounted.current=true;controller.current=new AbortController();return()=>{mounted.current=false;controller.current.abort();onDirty(false);};},[onDirty]);
  useEffect(()=>{onDirty(allDirty);},[allDirty,onDirty]);
  useEffect(()=>{if(!allDirty)return;const guard=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[allDirty]);
  const endpoint=`/chats/${chatId}/skills`;
  const refresh=async()=>{const next=await request<View>(endpoint,{signal:controller.current.signal});if(mounted.current)setView(next);};
  useEffect(()=>{void refresh().catch(e=>setError(errorText(e)));},[chatId]);
  useEffect(()=>{
    if(!dirty||!name||document?.scope==='personal')return;
    const path=`.abyssus/skills/${name}/SKILL.md`;
    const lease=()=>post(`/projects/${projectId}/editor`,{path,owner:owner.current,dirty:true}).catch(e=>setError(errorText(e)));
    void lease();const timer=setInterval(lease,15000);
    return()=>{clearInterval(timer);void post(`/projects/${projectId}/editor`,{path,owner:owner.current,dirty:false}).catch(()=>{});};
  },[dirty,name,document?.scope,projectId]);
  const act=async(operation:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setError('');try{await operation();if(!mounted.current)return;await refresh();onChange();}catch(e){if(mounted.current)setError(errorText(e));}finally{if(mounted.current)setBusy(false);}};
  const load=async(scope:string,skill:string)=>{
    const loaded=await request<SkillDocument>(`${endpoint}/document?scope=${scope}&name=${encodeURIComponent(skill)}`,{signal:controller.current.signal});
    if(!mounted.current)return;
    setDocument(loaded);setName(skill);setContent(loaded.content);setBase(loaded.content);setPreview(undefined);
  };
  const chooseDraft=async(draft:SkillDraft)=>{
    const file=await request<{hash:string|null;content:string}>(`/projects/${projectId}/file?path=${encodeURIComponent(`.abyssus/skills/${draft.name}/SKILL.md`)}`,{signal:controller.current.signal});
    if(!mounted.current)return;
    setName(draft.name);setContent(draft.content);setBase(file.content);setDocument({scope:'project',name:draft.name,description:'Draft',references:[],content:file.content,hash:file.hash??'',revision:'',resources:[]});setPreview(undefined);
  };
  return <Modal title="Skills" titleId="skills-title" busy={busy} onClose={()=>allDirty?setDiscard(true):onClose()} className="skills-dialog">
    <p className="muted">Reusable workflow guidance. Invoking selects instructions and pauses for your next message or Resume. It never starts building.</p>
    {error&&<p role="alert">{error}</p>}
    {outcome&&<p role="status">{outcome}</p>}
    {view?.selection.stale&&<p role="alert">{view.selection.stale}</p>}
    {discard&&<p>Discard unsaved skill edits? <button onClick={onClose}>Discard and close</button> <button onClick={()=>setDiscard(false)}>Keep editing</button></p>}
    <div className="skills-columns"><section aria-label="Available skills">
      <h3>Available</h3>
      {view?.catalog.entries.map(entry=><button className="skill-entry" key={`${entry.scope}/${entry.name}`} disabled={busy||allDirty} onClick={()=>void act(()=>load(entry.scope,entry.name))}><strong>{entry.name}</strong><span>{entry.scope}{entry.shadowed?' · shadowed in discovery':''}</span><small>{entry.description}</small></button>)}
      {view?.catalog.diagnostics.map((d,i)=><p key={i} role="status">{d.scope}/{d.entry}: {d.message}</p>)}
      {!view?.catalog.entries.length&&<p className="muted">No saved workflows yet.</p>}
      <h3>Selected</h3>
      <p className="muted">Selection revision {view?.selection.revision??0}{view?.selection.stale?' · stale':' · pinned'}</p>
      {view?.selection.entries.map(entry=><div key={`${entry.scope}/${entry.name}`}>{entry.scope}/{entry.name} · {entry.revision?.slice(0,12)} <button disabled={busy} onClick={()=>void act(()=>post(`${endpoint}/deselect`,{scope:entry.scope,name:entry.name,selectionRevision:view.selection.revision}))}>Deselect</button></div>)}
      <h3>Drafts</h3>
      {view?.drafts.map(d=><button key={d.name} disabled={busy||allDirty} onClick={()=>void act(()=>chooseDraft(d))}>{d.name} · revision {d.revision}</button>)}
      <p className="muted">Ask the architect to “turn this completed work into a skill”, or draft one below.</p>
    </section><section aria-label="Skill editor">
      {!content&&<form onSubmit={e=>{e.preventDefault();void act(async()=>{
        const existing=view?.drafts.find(d=>d.name===name);
        const draft=await post<SkillDraft>(`${endpoint}/draft`,{name,description,references:[],body,expectedRevision:existing?.revision??0});await chooseDraft(draft);
      });}}>
        <label>Name<input aria-label="Skill name" value={name} onChange={e=>{onDirty(!!(e.target.value||description||body));setName(e.target.value);}} placeholder="verify-changes" required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={64}/></label>
        <label>Description<input aria-label="Skill description" value={description} onChange={e=>{onDirty(!!(name||e.target.value||body));setDescription(e.target.value);}} required maxLength={512}/></label>
        <label>Workflow<textarea aria-label="Workflow steps" value={body} onChange={e=>{onDirty(!!(name||description||e.target.value));setBody(e.target.value);}} rows={8} required maxLength={28000}/></label>
        <button disabled={busy}>Create draft</button>
      </form>}
      {content&&<><h3>{document?.scope??'project'}/{name}</h3><label>Workflow document<textarea aria-label="Workflow document" value={content} readOnly={document?.scope==='personal'} onChange={e=>{onDirty(e.target.value!==base);setContent(e.target.value);setPreview(undefined);}} rows={15} maxLength={32000}/></label>
        {document?.resources.map(r=><details key={r.path}><summary>{r.path}</summary><pre>{r.content}</pre></details>)}
        <div className="skills-actions">
          {document?.scope!=='personal'&&<button disabled={busy} onClick={()=>void act(async()=>{await post(`${endpoint}/draft-content`,{name,content,expectedRevision:view?.drafts.find(d=>d.name===name)?.revision??0});setOutcome('Draft retained in this chat. No workflow file was saved.');setBase(content);})}>Keep draft</button>}
          <button disabled={busy||dirty||content!==document?.content||!document?.revision} onClick={()=>void act(()=>post(`${endpoint}/invoke`,{scope:document!.scope,name,revision:document!.revision,selectionRevision:view!.selection.revision}))}>Invoke guidance</button>
          {document?.scope!=='personal'&&<button disabled={busy||planOnly} onClick={()=>void act(async()=>setPreview(await post<SkillWritePreview>(`${endpoint}/save-preview`,{name,content,baseHash:document?.hash||null,owner:owner.current})))}>Preview save</button>}
          {document?.scope==='project'&&<button disabled={busy||dirty||content!==document.content||planOnly||!document.revision} onClick={()=>void act(async()=>setPreview(await post<SkillWritePreview>(`${endpoint}/promote-preview`,{name,revision:document.revision})))}>Promote to personal</button>}
          <button disabled={busy||dirty} onClick={()=>{setContent('');setBase('');setDocument(undefined);setName('');setDescription('');setBody('');setPreview(undefined);}}>New draft</button>
          {dirty&&<button disabled={busy} onClick={()=>{setContent(base);setPreview(undefined);}}>Discard edits</button>}
        </div></>}
      {planOnly&&<p className="muted">Planning mode: drafts and guidance only. Start building is required to save or promote.</p>}
      {preview&&<section aria-label="Skill save preview"><p>Destination: <code>{preview.destination}</code></p><pre className="skill-diff">{preview.diff}</pre><button disabled={busy||planOnly} onClick={()=>void act(async()=>{await post(`${endpoint}/save`,{id:preview.id,destination:preview.destination});setOutcome(`Saved to ${preview.destination}. Status: confirmed.`);setPreview(undefined);if(preview.scope==='project')await load('project',name);})}>Confirm {preview.scope==='personal'?'personal promotion':'save'}</button><button onClick={()=>setPreview(undefined)}>Cancel</button></section>}
    </section></div>
  </Modal>;
}
