import {useRef,useState} from 'react';
import type {Project,ProjectTransferReceipt} from '../shared/types';
import {request,errorText} from './api';
import {Modal} from './Modal';
export function TransferDialog({project,onClose,onImported}:{project?:Project;onClose:()=>void;onImported?:(project:Project)=>void}) {
  const [code,setCode]=useState(''),[name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [receipt,setReceipt]=useState<ProjectTransferReceipt>(),[imported,setImported]=useState<Project>();
  const native=window.abyssusDesktop;
  const controller=useRef<AbortController>(undefined);
  const run=async()=>{
    setBusy(true);setError('');controller.current=new AbortController();
    try {
      const result=await request<ProjectTransferReceipt|{project:Project;receipt:ProjectTransferReceipt}>(project?`/projects/${project.id}/export`:'/project-transfers/import',{
        method:'POST',body:JSON.stringify(project?{code}:{code,name}),signal:AbortSignal.any([controller.current.signal,AbortSignal.timeout(16*60_000)])});
      if('receipt' in result){setReceipt(result.receipt);setImported(result.project);}else setReceipt(result);
    }catch(e){setError(`${errorText(e)} Inspect the retained host transfer record before starting another copy.`);}finally{setBusy(false);}
  };
  return <Modal title={project?'Export project copy':'Import project copy'} titleId="transfer-title" onClose={onClose} busy={busy}>
    <p>{project?'Save a separate copy to a new destination. Existing folders are never overwritten.':'Copy a selected project once into managed storage. Your original folder stays separate.'}</p>
    {!receipt&&<>{!native&&<p className="field-help">Container source flow: run <code>bash scripts/project-transfer.sh</code> in the source checkout’s host terminal. Review the selected folder, exclusions and Git-history choice there, then paste its single-use code below.</p>}
      {project&&!native&&<p>Managed folder identity: <code>{project.path.split('/').at(-1)}</code></p>}
      {!project&&<label>Project name<input maxLength={100} value={name} disabled={busy} onChange={e=>setName(e.target.value)}/></label>}
      {native?<button className="button" disabled={busy} onClick={()=>{setBusy(true);setError('');void native.authorizeTransfer(project?{kind:'export',projectId:project.id}:{kind:'import'}).then(result=>{if(result)setCode(result.code);}).catch(e=>setError(errorText(e))).finally(()=>setBusy(false));}}>{code?'Choose another folder':project?'Choose export destination':'Choose source folder'}</button>:<label>Transfer code<input autoComplete="off" spellCheck={false} value={code} disabled={busy} onChange={e=>setCode(e.target.value.trim())}/></label>}
      <p className="field-help">Dependencies, caches and sensitive files are excluded by default. Included Git history can retain deleted secrets. Copies never sync or write back.</p></>}
    {busy&&<p role="status">Copying and verifying files… Keep this window open.</p>}
    {error&&<p role="alert">{error}</p>}
    {receipt&&<div role="status"><p>Copy completed: {receipt.files} files, {receipt.bytes.toLocaleString()} bytes. {receipt.excludedCount} excluded entries. {receipt.history?'Selected Git history retained; hooks/config/logs omitted.':'Fresh local Git repository created.'}</p>
      {receipt.excluded.length>0&&<details><summary>Excluded files and folders</summary><ul>{receipt.excluded.map(e=><li key={e.path}><code>{e.path}</code>: {e.reason}</li>)}</ul>{receipt.excludedCount>receipt.excluded.length&&<p>First 100 shown. Full manifest is retained privately on the host.</p>}</details>}</div>}
    {project&&!receipt&&<button className="text-button" disabled={busy||!/^[a-f0-9]{64}$/.test(code)} onClick={()=>{
      setBusy(true);setError('');void request(`/projects/${project.id}/transfer-release`,{method:'POST',body:JSON.stringify({code})}).then(()=>setError('Host confirmed the export is stopped. Reservation released; retained output was not retried or deleted.')).catch(e=>setError(errorText(e))).finally(()=>setBusy(false));
    }}>Verify stopped export and release reservation</button>}
    <div className="dialog-actions">{busy?<button className="button" onClick={()=>controller.current?.abort()}>Cancel copy</button>:<button className="button" onClick={onClose}>Close</button>}
      {imported?<button className="button primary" onClick={()=>onImported?.(imported)}>Open project</button>:!receipt&&<button className="button primary" disabled={busy||!/^[a-f0-9]{64}$/.test(code)||!project&&!name.trim()} onClick={()=>void run()}>{project?'Export copy':'Import copy'}</button>}
    </div>
  </Modal>;
}
