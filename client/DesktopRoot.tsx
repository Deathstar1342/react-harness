import { useEffect, useState } from 'react';
import type { DesktopStatus } from '../desktop/contracts';
import { App } from './App';
import { errorText, post, request } from './api';
import logo from './assets/abyssus-logo.png';

export function DesktopRoot() {
  const bridge=window.abyssusDesktop;
  const [status,setStatus]=useState<DesktopStatus>();
  const [opened,setOpened]=useState(false),[showSetup,setShowSetup]=useState(false);
  const [paired,setPaired]=useState(false),[pairRequired,setPairRequired]=useState(false),[code,setCode]=useState('');
  const [environment,setEnvironment]=useState(''),[home,setHome]=useState(''),[legacyRoot,setLegacyRoot]=useState('');
  const [mode,setMode]=useState<'existing'|'initialize'|'migrate'>('existing');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    if(!bridge){void request('/health').then(()=>setPaired(true)).catch(e=>{setPairRequired(true);if(e.status!==401)setError(errorText(e));});return;}
    let active=true;
    const refresh=()=>void bridge.status().then(next=>{if(!active)return;setStatus(next);if(next.phase==='ready')setOpened(true);});
    void bridge.status().then(next=>{if(!active)return;setStatus(next);setHome(next.selection?.home??'');setEnvironment(next.selection?.environment.kind==='wsl'?next.selection.environment.distribution:next.platform==='linux'?'linux':'');});
    const timer=setInterval(refresh,2000);return()=>{active=false;clearInterval(timer);};
  },[bridge]);
  const run=async(action:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setError('');try{await action();}catch(e){setError(errorText(e));}finally{setBusy(false);}};
  if(!bridge) {
    if(paired)return <App/>;
    return <main className="desktop-setup"><img src={logo} alt="abysSUS"/><h1>Connect this browser</h1><p>Enter the single-use pairing code displayed by your running backend. The code expires after five minutes.</p>
      {pairRequired&&<form onSubmit={e=>{e.preventDefault();void run(async()=>{await post('/auth/pair',{code});setCode('');setPaired(true);});}}><label>Pairing code<input type="password" autoComplete="off" value={code} onChange={e=>setCode(e.target.value)}/></label><button className="button primary" disabled={busy}>Connect</button></form>}
      {error&&<p role="alert">{error}</p>}</main>;
  }
  const needsSetup=!opened||showSetup||status?.phase!=='ready';
  return <>
    {opened&&<App/>}
    {opened&&<button className="desktop-environment" onClick={()=>setShowSetup(true)}>Desktop · {status?.selection?.environment.kind==='wsl'?status.selection.environment.distribution:'Linux'}</button>}
    {needsSetup&&<div className={opened?'desktop-overlay':''}><main className="desktop-setup" aria-label="Desktop setup">
      <img src={logo} alt="abysSUS"/><h1>{status?.phase==='ready'?'Desktop environment':'Open your workspace'}</h1>
      <p>{status?.message??'Reading desktop setup…'}</p>
      {status?.phase!=='ready'&&<form onSubmit={e=>{e.preventDefault();void run(async()=>{
        const result=await bridge.start({environment:environment==='linux'?{kind:'linux'}:{kind:'wsl',distribution:environment},home,mode,...(mode==='migrate'?{legacyRoot}:{})});setStatus(result);if(result.phase==='ready'){setOpened(true);setShowSetup(true);}
      });}}>
        <label>Execution environment<select required value={environment} onChange={e=>setEnvironment(e.target.value)} disabled={busy}><option value="">Choose explicitly…</option>{status?.platform==='linux'?<option value="linux">Native Ubuntu / Debian Linux</option>:status?.distributions.map(name=><option key={name}>{name}</option>)}</select></label>
        {status?.platform==='win32'&&!status.distributions.length&&<p>No supported Ubuntu/Debian WSL2 distribution was found. Ask your administrator to install one and stage the abysSUS backend. Service distributions are not used.</p>}
        <label>Persistent profile home (Linux path)<input required placeholder="/home/your-name/.local/share/abyssus" value={home} onChange={e=>setHome(e.target.value)} disabled={busy}/></label>
        <label>Profile action<select value={mode} onChange={e=>setMode(e.target.value as typeof mode)} disabled={busy}><option value="existing">Open existing profile</option><option value="initialize">Initialize a new profile</option><option value="migrate">Migrate a legacy installation</option></select></label>
        {mode==='migrate'&&<><label>Legacy installation (Linux path)<input required value={legacyRoot} onChange={e=>setLegacyRoot(e.target.value)} disabled={busy}/></label><p>Stop every old backend first. Migration preserves original files and receipts; profiles are never merged.</p></>}
        <button className="button primary" disabled={busy||!environment||status?.phase==='starting'||status?.phase==='stopping'}>{busy?'Opening…':'Open profile'}</button>
      </form>}
      {status?.checks&&<ul>{status.checks.map(check=><li key={check.name}><strong>{check.name}: {check.ok?'available':'needs attention'}</strong>{!check.ok&&<p>{check.message}</p>}</li>)}</ul>}
      {status?.phase==='ready'&&<><h2>Optional system installs</h2><p>Setup requires an administrator-staged helper and an OS authentication agent in this Linux environment. You can continue without enabling system installs.</p>
        <div className="dialog-actions">{(['setup','repair','uninstall'] as const).map(action=><button key={action} className="button" disabled={busy} onClick={()=>void run(async()=>setStatus(await bridge.helper(action)))}>{action==='setup'?'Enable helper':action==='repair'?'Repair helper':'Remove helper'}</button>)}</div>
        {status.helper?.target&&<p>Verified target: {status.helper.target}</p>}<button className="button primary" onClick={()=>setShowSetup(false)}>Continue to chats</button></>}
      {error&&<p className="inline-error" role="alert">{error}</p>}
    </main></div>}
  </>;
}
