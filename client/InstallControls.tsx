import { useEffect, useState } from 'react';
import type { InstallRecord, InstallSettingsView, PackageHelperPreview } from '../shared/types';
import { errorText, id, post, request } from './api';

export function InstallPreview({preview}: {preview:PackageHelperPreview}) {
  return <div className="install-preview">
    <p><strong>Linux target: {preview.target.distribution} {preview.target.release} · {preview.target.architecture}</strong></p>
    <p className="field-help">Installs run in this Linux environment. Package maintainer scripts run as root; triggers can change existing packages and services. Package-defined service changes and script effects are not bounded by download size.</p>
    <ul>{preview.packages.map(p=><li key={p.name}><strong>{p.name} {p.version}</strong> · {p.architecture} · {p.requested?'requested':'dependency'}<br/>{p.repositories.map(r=>`${r.origin} / ${r.archive} / ${r.component} / ${r.site}`).join('; ')}</li>)}</ul>
    <p>{preview.impact.newPackages} new packages · {preview.impact.downloadBytes} download bytes · {preview.impact.installedBytes} declared installed bytes. No upgrades, downgrades or removals.</p>
    <details><summary>Exact versions, provenance and target identity</summary><pre>{JSON.stringify(preview,null,2)}</pre></details>
  </div>;
}

export function InstallHistory({chatId}: {chatId?:string}) {
  const [open,setOpen]=useState(false), [items,setItems]=useState<InstallRecord[]>([]), [error,setError]=useState(''), [busy,setBusy]=useState(false), [truncated,setTruncated]=useState(false);
  const load=async()=>{const data=await request<{items:InstallRecord[];truncated:boolean}>('/system-installs/history');setItems(data.items.filter(i=>!chatId||i.chatId===chatId));setTruncated(data.truncated);};
  const action=async(item:InstallRecord,kind:string)=>{setBusy(true);setError('');try{await post(`/system-installs/${id(item.id)}/${kind}`,{});await load();}catch(e){setError(errorText(e));}finally{setBusy(false);}};
  return <details className="approval-history" open={open} onToggle={event=>{const expanded=event.currentTarget.open;setOpen(expanded);if(expanded)void load().catch(e=>setError(errorText(e)));}}>
    <summary>System install history</summary>
    {open && <><button className="text-button" onClick={()=>void load().catch(e=>setError(errorText(e)))}>Refresh outcomes</button>
      {!items.length&&<p>No system install requests recorded.</p>}{truncated&&<p>Latest 100 profile records shown. Earlier records remain in the backend.</p>}
      {items.map(item=><article key={item.id} className="install-history-item"><strong>{item.recommendation.packages.map(p=>p.name).join(', ')} · {item.state}</strong><p>{item.code} · {item.decision ? `${item.decision.source}: ${item.decision.outcome} — ${item.decision.reason}`:'No approval decision'}</p>
        <p>{item.recommendation.reason}</p><p className="field-help">{new Date(item.createdAt).toLocaleString()} · {item.settings.target?`${item.settings.target.distribution} ${item.settings.target.release}`:'Target unavailable'}</p>
        {item.recoveryRequired&&<p role="status">Outcome needs recovery. Cancellation does not undo package effects. Installation will not be replayed.</p>}
        {item.reconciliation&&<p>Observed package versions {item.reconciliation.matches?'match':'do not all match'}; package manager {item.reconciliation.healthy?'healthy':'needs repair'}. Original outcome remains {item.state}.</p>}
        {['uncertain','failed','succeeded'].includes(item.state)&&<><button disabled={busy} className="text-button" onClick={()=>void action(item,'status')}>Check helper status</button> <button disabled={busy} className="text-button" onClick={()=>void action(item,'reconcile')}>Reconcile installed state</button></>}
        {item.preview&&<details><summary>Reviewed package preview</summary><InstallPreview preview={item.preview}/></details>}
      </article>)}{error&&<p role="alert" className="inline-error">{error}</p>}</>}
  </details>;
}

export function InstallSettingsControls() {
  const [settings,setSettings]=useState<InstallSettingsView|null>(null), [model,setModel]=useState(''), [models,setModels]=useState<string[]>([]), [error,setError]=useState(''), [busy,setBusy]=useState(false);
  const load=async()=>{const next=await request<InstallSettingsView>('/system-installs/settings');setSettings(next);setModel(next.reviewerModel);};
  useEffect(()=>{let active=true;void request<InstallSettingsView>('/system-installs/settings').then(next=>{if(active){setSettings(next);setModel(next.reviewerModel);}}).catch(e=>{if(active)setError(errorText(e));});return()=>{active=false;};},[]);
  const save=async(patch:object)=>{if(!settings||busy)return;setBusy(true);setError('');try{const next=await request<InstallSettingsView>('/system-installs/settings',{method:'PATCH',body:JSON.stringify({...patch,revision:settings.revision})});setSettings(next);setModel(next.reviewerModel);}catch(e){setError(errorText(e));}finally{setBusy(false);}};
  return <section className="settings-section"><h3>System installs</h3>
    <label>System install policy<select aria-label="System install policy" value={settings?.policy??'ask'} disabled={!settings||busy} onChange={e=>void save({policy:e.target.value})}><option value="ask">Ask every time</option><option value="auto">Auto-approve</option><option value="ai">AI review</option></select></label>
    <p className="field-help">Applies to this app profile and the selected Linux target. Workspace approval choices do not change it. Changes invalidate pending install decisions.</p>
    <p role="status">{settings?.message??'Checking selected Linux environment…'}{settings?.target&&` · ${settings.target.distribution} ${settings.target.release} (${settings.target.architecture})`}</p>
    <label>Install reviewer model<input aria-label="Install reviewer model" list="install-review-models" value={model} disabled={busy||!settings} onChange={e=>setModel(e.target.value)}/></label>
    <datalist id="install-review-models">{models.map(value=><option key={value} value={value}/>)}</datalist>
    <button className="text-button" disabled={busy||!settings||model===settings.reviewerModel} onClick={()=>void save({reviewerModel:model})}>Save reviewer model</button> <button className="text-button" onClick={()=>void request<{models:string[]}>('/models').then(data=>setModels(data.models)).catch(e=>setError(errorText(e)))}>Load model choices</button>
    <p className="field-help">Initially copied from the critic default. This selection is separate from saved chat roles. Failed or inconclusive reviews ask you to decide.</p>
    <button className="text-button" disabled={busy} onClick={()=>void load().catch(e=>setError(errorText(e)))}>Refresh environment</button>
    {error&&<p role="alert" className="inline-error">{error}</p>}<InstallHistory/>
  </section>;
}
