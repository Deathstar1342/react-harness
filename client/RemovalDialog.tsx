import { useId, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { Chat, DeletionPreview, Project, ProjectRemoval } from '../shared/types';
import { errorText, id, post, request } from './api';
import { Modal } from './Modal';

export function Overflow({label,onRemove}: {label:string;onRemove:()=>void}) {
  const [open,setOpen]=useState(false);
  const trigger=useRef<HTMLButtonElement>(null);
  const menuId=useId();
  return <div className="row-overflow" onBlur={event=>{if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);}}
    onKeyDown={event=>{if(event.key==='Escape') {event.stopPropagation();setOpen(false);trigger.current?.focus();}}}>
    <button ref={trigger} className="icon-button overflow-trigger" aria-label={`${label} options`} aria-expanded={open} aria-controls={menuId}
      onClick={()=>setOpen(!open)}><MoreHorizontal size={16}/></button>
    {open && <div id={menuId} className="overflow-popover"><button className="navigation-row danger-text" onClick={()=>{trigger.current?.focus();setOpen(false);onRemove();}}>Remove {label.startsWith('Project') ? 'project' : 'chat'}</button></div>}
  </div>;
}

export const removeProject=(projectId:string,body:ProjectRemoval)=>request(`/projects/${id(projectId)}`,{method:'DELETE',body:JSON.stringify(body)});
export const removeChat=(chatId:string)=>request(`/chats/${id(chatId)}`,{method:'DELETE',body:'{}'});

export function RemovalDialog({project,chat,blocked,onClose,onRemoved,onFailure}: {
  project:Project;chat?:Chat;blocked:boolean;onClose:()=>void;onRemoved:()=>void;onFailure:()=>void;
}) {
  const [preview,setPreview]=useState<DeletionPreview>();
  const [confirmation,setConfirmation]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const act=async(operation:()=>Promise<unknown>,finish=false)=>{
    if(busy || blocked) return;
    setBusy(true);setError('');
    try {await operation();if(finish) onRemoved();}
    catch(e) {setError(errorText(e));setPreview(undefined);setConfirmation('');onFailure();}
    finally {setBusy(false);}
  };
  return <Modal title={chat ? 'Delete chat' : preview ? 'Confirm file deletion' : 'Remove project'} titleId="removal-title" onClose={onClose} busy={busy}>
    {chat ? <p>Delete “{chat.title}” and its conversation, approvals, and recorded history? Project files will remain.</p> : preview ? <>
      <p>Permanently delete this directory and every file inside it, including imported files and Git history. This cannot be undone.</p>
      <pre className="removal-path">{preview.canonicalPath}</pre>
      <label className="field-label" htmlFor="confirm-removal-path">Type the exact directory path to confirm</label>
      <input id="confirm-removal-path" value={confirmation} onChange={event=>setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} disabled={busy}/>
    </> : <><p>Remove “{project.name}” and all its chats from abysSUS. Choose whether to keep the project files.</p><pre className="removal-path">{project.path}</pre></>}
    {project.removalError && <p role="alert">{project.removalError}</p>}
    {blocked && <p role="alert">Save or discard your file edits before removing a chat or project.</p>}
    {error && <p role="alert">{error}</p>}
    <div className="dialog-actions removal-actions">
      <button className="button" disabled={busy} onClick={onClose}>Cancel</button>
      {chat ? <button className="button danger-text" disabled={busy || blocked} onClick={()=>void act(()=>removeChat(chat.id),true)}>Delete chat</button> : preview ?
        <button className="button danger-text" disabled={busy || blocked || confirmation!==preview.canonicalPath} onClick={()=>void act(()=>removeProject(project.id,{mode:'disk',canonicalPath:confirmation,confirmationToken:preview.confirmationToken}),true)}>Permanently delete project and files</button> : <>
        <button className="button" disabled={busy || blocked} onClick={()=>void act(()=>removeProject(project.id,{mode:'app-only'}),true)}>Remove from app only</button>
        <button className="button danger-text" disabled={busy || blocked} onClick={()=>void act(async()=>setPreview(await post<DeletionPreview>(`/projects/${id(project.id)}/deletion-preview`,{})))}>Delete project and files</button>
      </>}
    </div>
  </Modal>;
}
