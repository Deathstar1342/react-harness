import { useEffect, useRef, useState } from 'react';
import type { ProviderSettings, ProviderSettingsPatch, PublicSettings, RoleModels } from '../shared/types';
import { errorText, request } from './api';

const roles = ['architect','coder','critic'] as const;
export function ProviderSettingsControls({onSettings,onSaved}: {onSettings?: (settings:PublicSettings)=>void;onSaved?:()=>void}) {
  const [settings,setSettings] = useState<ProviderSettings | null>(null);
  const [models,setModels] = useState<RoleModels>({architect:'',coder:'',critic:''});
  const [catalog,setCatalog] = useState<string[]>([]);
  const [catalogStatus,setCatalogStatus] = useState('');
  const [key,setKey] = useState('');
  const [baseUrl,setBaseUrl]=useState('');
  const [clearKey,setClearKey] = useState(false);
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState('');
  const [error,setError] = useState('');
  const mounted = useRef(false), lock = useRef(false);
  async function discover() {
    setCatalogStatus('Loading model catalog…');
    try {
      const result = await request<{models:string[]}>('/models');
      if (mounted.current) {setCatalog(result.models);setCatalogStatus(result.models.length ? 'Choose a catalog ID or type an exact model ID.' : 'Catalog is empty. Type exact model IDs manually.');}
    } catch { if (mounted.current) setCatalogStatus('Catalog unavailable. You can still type exact model IDs manually.'); }
  }
  useEffect(()=>{
    mounted.current = true;
    void request<ProviderSettings>('/provider-settings').then(value=>{if(mounted.current){setSettings(value);setModels(value.models);setBaseUrl(value.baseUrl??'');}}).catch(e=>{if(mounted.current)setError(errorText(e));});
    void discover();
    return ()=>{mounted.current=false;};
  },[]);
  const locked = (field:string) => !settings || settings.lockedFields.includes(field);
  return <section className="settings-section">
    <h3>Provider defaults</h3>
    <label>STARK API endpoint<input aria-label="STARK API endpoint" value={baseUrl} maxLength={2048} placeholder="https://your-work-provider/v1" disabled={busy||locked('baseUrl')} onChange={event=>setBaseUrl(event.target.value)}/></label>
    <p className="field-help">Include the API path supplied by your provider. Changing the endpoint requires a replacement key or clearing the saved key. Saving does not test the connection.</p>
    {settings?.lockedFields.includes('baseUrl')&&<p className="field-help">Endpoint is set by STARK_BASE_URL in the process environment. Remove that override and restart to edit here.</p>}
    <p className="field-help">Model changes apply to new chats only. Existing chats keep their saved architect, coder and critic models.</p>
    {roles.map(role=><label key={role}>{role[0].toUpperCase()+role.slice(1)} model
      <input aria-label={`${role} default model`} list="provider-model-catalog" value={models[role]} maxLength={1024} disabled={busy || locked(role)} onChange={event=>setModels(old=>({...old,[role]:event.target.value}))} />
      {settings?.lockedFields.includes(role) && <span className="field-help">Set by the process environment. Remove its override and restart to edit here.</span>}
    </label>)}
    <datalist id="provider-model-catalog">{catalog.map(model=><option key={model} value={model}/>)}</datalist>
    <p className="field-help" role="status">{catalogStatus}</p>
    <button type="button" className="text-button" disabled={busy} onClick={()=>void discover()}>Refresh model catalog</button>
    <label>API key {settings ? settings.apiKeyConfigured ? '· configured' : '· not configured' : ''}
      <input aria-label="Replacement API key" type="password" autoComplete="new-password" value={key} maxLength={1024} placeholder="Leave blank to keep the current key" disabled={busy || locked('apiKey') || clearKey} onChange={event=>setKey(event.target.value)} />
    </label>
    <label className="provider-clear-key"><input type="checkbox" checked={clearKey} disabled={busy || locked('apiKey')} onChange={event=>{setClearKey(event.target.checked);setKey('');}}/> Clear saved API key</label>
    {settings?.lockedFields.includes('apiKey') && <p className="field-help">API key is set by the process environment. Remove STARK_API_KEY from that environment and restart to edit here.</p>}
    <p className="field-help">The shared key applies to the next provider request in every chat. Requests already in flight keep their captured credentials. The stored key is never shown.</p>
    <button type="button" className="button" disabled={busy || !settings || roles.some(role=>!models[role].trim())} onClick={()=>{
      if (lock.current || !settings) return;
      lock.current=true;setBusy(true);setError('');setNotice('');
      const patch: ProviderSettingsPatch = {models:Object.fromEntries(roles.filter(role=>!locked(role) && models[role]!==settings.models[role]).map(role=>[role,models[role]]))};
      if(!locked('baseUrl')&&baseUrl!==(settings.baseUrl??''))patch.baseUrl=baseUrl;
      if (!locked('apiKey') && (clearKey || key)) patch.apiKey=clearKey ? '' : key;
      // Release the typed credential from React state as soon as it is submitted.
      setKey('');setClearKey(false);
      void request<ProviderSettings>('/provider-settings',{method:'PATCH',body:JSON.stringify(patch)}).then(async value=>{
        onSaved?.();
        if (mounted.current) {setSettings(value);setModels(value.models);setBaseUrl(value.baseUrl??'');setNotice('Provider settings saved. Model defaults apply to new chats only.');}
        const publicSettings=await request<PublicSettings>('/settings');onSettings?.(publicSettings);
      }).catch(e=>{if(mounted.current)setError(errorText(e));}).finally(()=>{lock.current=false;if(mounted.current)setBusy(false);});
    }}>{busy ? 'Saving provider settings…' : 'Save provider settings'}</button>
    {notice && <p className="field-help" role="status">{notice}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
