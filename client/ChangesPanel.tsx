import { useEffect, useRef, useState } from 'react';
import type { ChangePreview, ProjectChanges } from '../shared/types';
import { errorText, id, post, request } from './api';
import { Modal } from './Modal';

function DiffText({text}: {text:string}) {
  return <pre className="change-diff">{text.split('\n').map((line,index)=><span key={index} className={line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : line.startsWith('@@') ? 'location' : ''}>{line}{'\n'}</span>)}</pre>;
}

export function ChangeReview({preview,busy,onUndo}: {preview:ChangePreview;busy:boolean;onUndo:()=>void}) {
  return <section aria-label="Recorded write preview">
    <h3>{preview.change.path}</h3>
    <p>Recorded agent write · {preview.change.status} · {new Date(preview.change.createdAt).toLocaleString()}</p>
    <p className="muted">Chat {preview.change.chatId}</p>
    <h4>Recorded write</h4><DiffText text={preview.diff || 'No textual difference.'} />
    <h4>Undo preview</h4><DiffText text={preview.undoDiff || 'No textual difference.'} />
    {preview.reason ? <p role="status">{preview.reason}</p> : <>
      <p>Undo only this write. Pause all active project chats first. Saved or unsaved edits made later will block undo. Shell effects cannot be undone here.</p>
      <button className="button" disabled={busy || !preview.previewToken || !preview.expectedHash} onClick={onUndo}>{busy ? 'Undoing…' : 'Undo this write'}</button>
    </>}
  </section>;
}

export function ChangesPanel({projectId,revision,onClose}: {projectId:string;revision:number;onClose:()=>void}) {
  const [data,setData] = useState<ProjectChanges>();
  const [preview,setPreview] = useState<ChangePreview>();
  const [diff,setDiff] = useState<{path:string;diff:string}>();
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [refresh,setRefresh] = useState(0);
  const sequence = useRef(0);
  const alive = useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;sequence.current++;};},[]);
  useEffect(()=>{
    const controller = new AbortController();
    sequence.current++; setPreview(undefined); setDiff(undefined); setError('');
    void request<ProjectChanges>(`/projects/${id(projectId)}/changes`,{signal:controller.signal}).then(setData).catch(e=>{if (!controller.signal.aborted) setError(errorText(e));});
    return()=>controller.abort();
  },[projectId,revision,refresh]);
  async function select(kind:'git'|'write', value:string) {
    const current = ++sequence.current;
    setPreview(undefined);setDiff(undefined);setError('');
    try {
      if (kind === 'write') {
        const result = await request<ChangePreview>(`/projects/${id(projectId)}/change/${id(value)}`);
        if (alive.current && current === sequence.current) setPreview(result);
      } else {
        const result = await request<{diff:string}>(`/projects/${id(projectId)}/diff?path=${id(value)}`);
        if (alive.current && current === sequence.current) setDiff({path:value,...result});
      }
    } catch(e) {if (alive.current && current === sequence.current) setError(errorText(e));}
  }
  async function undo() {
    if (busy || !preview?.previewToken || !preview.expectedHash) return;
    setBusy(true);setError('');
    try {
      await post(`/projects/${id(projectId)}/change/${id(preview.change.id)}/undo`,{expectedHash:preview.expectedHash,previewToken:preview.previewToken});
      if (alive.current) {setPreview(undefined);setRefresh(value=>value+1);}
    } catch(e) {if (alive.current) setError(errorText(e));}
    finally {if (alive.current) setBusy(false);}
  }
  return <Modal title="Changes" titleId="changes-title" className="changes-dialog" onClose={onClose} busy={busy}>
    <button className="text-button" disabled={busy} onClick={()=>setRefresh(value=>value+1)}>Refresh changes</button>
    {error && <p role="alert">{error}</p>}
    <div className="changes-layout">
      <nav aria-label="Changed files">
        <h3>Current project Git changes</h3>
        <p className="muted">Includes pre-existing work, manual edits and shell effects. These files are not necessarily agent edits.</p>
        {data?.gitError && <p role="status">{data.gitError}</p>}
        {data?.git.map(item=><button className="change-file" disabled={busy} key={item.path} onClick={()=>void select('git',item.path)}><code>{item.status}</code> {item.originalPath ? `${item.originalPath} → ` : ''}{item.path}</button>)}
        {data && !data.git.length && !data.gitError && <p>No current Git changes.</p>}
        <h3>Recorded agent writes</h3>
        <p className="muted">Individual write_file actions only. Older actions without snapshots have no undo.</p>
        {data?.history.map(item=><button className="change-file" disabled={busy} key={item.id} onClick={()=>void select('write',item.id)}>{item.path} <small>{item.status} · {new Date(item.createdAt).toLocaleString()}</small></button>)}
        {data && !data.history.length && <p>No recorded writes.</p>}
        {data?.historyTruncated && <p role="status">Showing the latest 100 records. Older history is not displayed.</p>}
      </nav>
      <div className="changes-review">
        {preview ? <ChangeReview preview={preview} busy={busy} onUndo={()=>void undo()} /> : diff ? <section><h3>{diff.path}</h3><p>Current Git diff; attribution is unknown.</p><DiffText text={diff.diff} /></section> : <p>Select a file or recorded write to review its diff.</p>}
      </div>
    </div>
  </Modal>;
}
