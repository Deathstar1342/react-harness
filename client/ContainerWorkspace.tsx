import { useEffect,useState } from 'react';
import type { DesktopBridge,DesktopStatus } from '../desktop/contracts';
import { App } from './App';
import { errorText } from './api';
import logo from './assets/abyssus-logo.png';
export function ContainerWorkspace({bridge,status:observed}:{bridge:DesktopBridge;status:DesktopStatus}) {
  const [status,setStatus]=useState(observed),[opened,setOpened]=useState(observed.phase==='ready'),[setup,setSetup]=useState(true),[offline,setOffline]=useState(false);
  const [choice,setChoice]=useState<{id:string;displayPath:string;mode:'existing'|'initialize'}>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{setStatus(observed);if(observed.phase==='ready')setOpened(true);},[observed]);
  const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');try{await action();}catch(e){setError(errorText(e));}finally{setBusy(false);}};
  const blocked=busy||status.transitioning;
  return <>
    {opened&&status.sessionId&&<App key={status.sessionId}/>}
    {opened&&<button className="desktop-environment" onClick={()=>{setOffline(false);setSetup(true);}}>Desktop · Containers{status.phase!=='ready'?' · Offline':''}</button>}
    {(!opened||setup||status.phase!=='ready'&&!offline)&&<div className={opened?'desktop-overlay':''}><main className="desktop-setup" aria-label="Desktop setup">
      <img src={logo} alt="abysSUS"/><h1>{status.phase==='ready'?'Your workspace is connected':'Open your workspace'}</h1>
      <p>{status.message}</p>
      <details><summary>Runtime and storage</summary><p>abysSUS needs a local Linux container engine: Docker Desktop on Windows, or Docker Engine on Linux. Start it before opening your workspace. The app does not install or reconfigure the engine.</p><p>Choose a local folder for projects, chats, settings and dependency caches, including a folder on D: on Windows. Original projects are copied once when imported. Export saves to a new destination.</p><p>Docker images and build cache use the engine’s separate disk. Selecting D: here does not move that disk. {status.platform==='win32'?'The engine’s Windows backing location has not been verified. Check it in Docker Desktop.':status.container?.engineDataRoot?`Engine-reported data root: ${status.container.engineDataRoot}`:''}</p></details>
      {status.phase!=='ready'&&<>
        <button className="button" disabled={blocked||status.phase==='starting'||status.phase==='stopping'} onClick={()=>void run(async()=>setStatus(await bridge.checkContainer()))}>Check runtime</button>
        <label>Persistent app storage<output>{choice?.displayPath??status.container?.storage?.displayPath??'Choose a folder…'}</output></label>
        <button className="button" disabled={blocked||status.phase==='starting'||status.phase==='stopping'} onClick={()=>void run(async()=>{const selected=await bridge.pickStorage();if(selected)setChoice(selected);})}>Choose storage folder</button>
        <button className="button primary" disabled={blocked||!status.container?.available||(!choice&&!status.container?.storage)||status.phase==='starting'||status.phase==='stopping'} onClick={()=>void run(async()=>{const next=await bridge.startContainer(choice?{selectionId:choice.id}:{});setStatus(next);if(next.phase==='ready'){setOpened(true);setChoice(undefined);}})}>{status.phase==='starting'?'Opening…':'Open workspace'}</button>
      </>}
      {opened&&status.phase!=='ready'&&<button className="button" disabled={blocked} onClick={()=>{setSetup(false);setOffline(true);}}>Return to editor buffers</button>}
      {status.phase==='ready'&&<><p>Open Settings to enter your provider address and key, then choose your architect, coder and critic models. Existing chats keep their model assignments.</p><p>Commands and package installs run in project containers. Workspace approval and system-install policies remain separate.</p><div className="dialog-actions"><button className="button" disabled={blocked} onClick={()=>void run(async()=>setStatus(await bridge.restartContainer()))}>Restart runtime</button><button className="button primary" onClick={()=>setSetup(false)}>Continue to chats</button></div></>}
      {error&&<p role="alert" className="inline-error">{error}</p>}
    </main></div>}
  </>;
}
