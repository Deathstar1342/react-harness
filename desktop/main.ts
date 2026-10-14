import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { DocumentGuard } from './document-guard.js';
import { DesktopController } from './controller.js';
import { desktopOrigin, environmentSchema, isDesktopURL, linuxPath, pickerPath, validateSender } from './policy.js';
import { desktopResponse } from './proxy.js';
const appRoot=fileURLToPath(new URL('../',import.meta.url));
app.setName('abysSUS');
nativeTheme.themeSource='dark';
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{scheme:'abyssus',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,allowServiceWorkers:false}}]);
if(app.isPackaged&&process.platform==='linux') {
  const desktopRelease=JSON.parse(readFileSync(path.join(appRoot,'release.json'),'utf8'));
  const backendRelease=JSON.parse(readFileSync('/opt/abyssus/app/release.json','utf8'));
  if(desktopRelease.source!==backendRelease.source)throw new Error('Desktop/backend package versions differ. Install the matching reviewed package set.');
}
let window:BrowserWindow|undefined,quitting=false,closing=false;
const documents=new DocumentGuard();
const controller=new DesktopController(app.isPackaged&&process.platform==='linux'?'/opt/abyssus/app':appRoot);
const selectionSchema=z.object({environment:environmentSchema,home:linuxPath}).strict();
if(!app.isPackaged&&!app.requestSingleInstanceLock())app.quit();
else {
  app.on('second-instance',()=>{window?.show();window?.focus();});
  await app.whenReady();
  const partition=session.fromPartition('abyssus-desktop'); // in memory, one isolated application session
  partition.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
  partition.setPermissionCheckHandler(()=>false);
  partition.on('will-download',event=>event.preventDefault());
  partition.webRequest.onBeforeRequest((details,callback)=>{
    // Electron-provided webContentsId/frame are used, never caller-supplied headers.
    const owner=window?.webContents;
    const allowed=!!owner&&details.webContentsId===owner.id&&isDesktopURL(details.url)&&
      (!details.frame||details.frame===owner.mainFrame);
    callback({cancel:!allowed});
  });
  partition.protocol.handle('abyssus',async request=>{
    const target=controller.target();
    try{return await desktopResponse(request,path.join(appRoot,'dist/client'),target?.sessionId===documents.sessionId?target:undefined);}
    catch{return Response.json({error:'Desktop connection failed. Reopen setup to inspect recovery.'},{status:503});}
  });
  const selectionFile=path.join(app.getPath('userData'),'desktop-selection.json');
  if(existsSync(selectionFile))try{controller.state.selection=selectionSchema.parse(JSON.parse(readFileSync(selectionFile,'utf8')));}
  catch{controller.state.message='Saved desktop selection needs recovery. Choose the existing profile explicitly; do not initialize a replacement.';}
  await controller.inventory();
  documents.selection=controller.state.selection;
  const freezeWindow=async(ticket:ReturnType<DocumentGuard['begin']>)=>{
    const owner=window!.webContents,nonce=randomUUID();
    const thaw=()=>{if(!owner.isDestroyed())owner.send('desktop:thaw',nonce);};
    try{await new Promise<void>((resolve,reject)=>{
      const finish=(error?:Error)=>{clearTimeout(timeout);ipcMain.off('desktop:frozen',frozen);error?reject(error):resolve();};
      const frozen=(event:Electron.IpcMainEvent,value:unknown)=>{
        try{validateSender(event,owner);}catch{return;}
        const parsed=z.object({nonce:z.literal(nonce),dirty:z.boolean()}).strict().safeParse(value);if(!parsed.success)return;
        if(parsed.data.dirty!==documents.dirty)documents.edited(parsed.data.dirty);
        try{documents.check(ticket);finish();}catch(error){finish(error as Error);}
      };
      const timeout=setTimeout(()=>finish(new Error('Editor did not confirm a safe transition. The window is preserved.')),5000);
      ipcMain.on('desktop:frozen',frozen);owner.send('desktop:freeze',nonce);
    });return thaw;}catch(error){thaw();throw error;}
  };
  const createWindow=()=>{
    documents.documentChanged();
    window=new BrowserWindow({width:1350,height:880,minWidth:740,minHeight:520,title:'abysSUS',backgroundColor:'#171717',show:false,autoHideMenuBar:process.platform==='win32',
      webPreferences:{partition:'abyssus-desktop',preload:path.join(appRoot,'desktop/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInWorker:false,webviewTag:false,webSecurity:true,allowRunningInsecureContent:false,devTools:false}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    window.webContents.on('will-redirect',event=>event.preventDefault());
    window.webContents.on('will-attach-webview',event=>event.preventDefault());
    window.webContents.on('will-prevent-unload',()=>{}); // dirty editor veto remains effective
    window.webContents.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame)documents.documentChanged();});
    window.webContents.on('render-process-gone',()=>{
      documents.documentChanged();documents.edited(true); // Unsaved text may have been lost.
      const crashedWindow=window!;
      void dialog.showMessageBox(crashedWindow,{type:'warning',title:'Window stopped',message:'The window stopped. Backend work remains tracked.',detail:'Unsaved editor text may have been lost. Reopen the window to inspect recorded state; actions are not replayed.',buttons:['Keep open','Reopen window'],defaultId:0,cancelId:0}).then(result=>{if(result.response===1&&window===crashedWindow&&!quitting){documents.edited(false);crashedWindow.destroy();createWindow();}});
    });
    window.on('close',event=>{if(!quitting){event.preventDefault();void closeApp();}});
    window.once('ready-to-show',()=>window?.show());
    void window.loadURL(desktopOrigin+'/');
  };
  async function closeApp() {
    if(closing||!window||documents.busy)return;closing=true;
    const ticket=documents.begin(true);let thaw:(()=>void)|undefined;
    try {
      const result=await dialog.showMessageBox(window,{type:'question',title:'Close abysSUS?',message:documents.dirty?'Unsaved editor changes will be lost.':'Close abysSUS and stop its backend?',detail:'Active tools and system-install calls must finish local cleanup. System changes are not rolled back. Recorded uncertain outcomes remain for review.',buttons:['Keep open','Close and wait'],defaultId:0,cancelId:0});
      if(result.response!==1)return;
      documents.check(ticket);thaw=await freezeWindow(ticket);
      await controller.stop();documents.check(ticket);quitting=true;window.destroy();app.quit();
    }catch{await dialog.showMessageBox(window,{type:'error',message:'Close was not completed. The window is preserved.',detail:'Editor changes or failed/unverified backend cleanup require review. Ownership remains while the backend is alive. Inspect recovery, then deliberately retry the close check; nothing was killed or replayed.'});}
    finally{thaw?.();documents.end(ticket);closing=false;}
  }
  const handler=(channel:string,fn:(input:unknown)=>unknown)=>ipcMain.handle(channel,(event,input)=>{validateSender(event,window?.webContents);return fn(input);});
  handler('desktop:status',()=>documents.status(controller.state));
  handler('desktop:dirty',input=>{documents.edited(z.boolean().parse(input));});
  handler('desktop:start',async input=>{
    const ticket=documents.begin();let thaw:(()=>void)|undefined,started=false;
    try {
    const {startSchema}=await import('./policy.js');const selected=startSchema.parse(input);
    const confirmed=await dialog.showMessageBox(window!,{type:'question',message:`${selected.mode==='initialize'?'Initialize':'Open'} the selected Linux profile?`,detail:`Environment: ${JSON.stringify(selected.environment)}\nProfile: ${selected.home}${selected.legacyRoot?'\nLegacy source: '+selected.legacyRoot+'\nStop every old backend before migration.':''}`,buttons:['Cancel','Continue'],defaultId:0,cancelId:0});
    if(confirmed.response!==1)return {...documents.status(controller.state),message:'Profile selection cancelled.'};
    documents.check(ticket);thaw=await freezeWindow(ticket);
    const previousSession=documents.sessionId;
    const result=await controller.start(input);
    started=true;documents.check(ticket);
    mkdirSync(path.dirname(selectionFile),{recursive:true});
    const temporary=selectionFile+'.tmp';writeFileSync(temporary,JSON.stringify(result.selection),{mode:0o600});renameSync(temporary,selectionFile);
    // A previous document's requests cannot reach a new backend session. Replace
    // the entire renderer (after the dirty guard), including all stale callbacks.
    documents.publish(result);
    if(previousSession&&previousSession!==result.sessionId){window!.destroy();createWindow();}
    return result;
    } catch(error) {
      // A ready but uncommitted backend never receives the old document's API.
      // Drain it without discarding the old buffers or releasing failed ownership.
      if(started)await controller.stop();
      throw error;
    } finally{thaw?.();documents.end(ticket);}
  });
  handler('desktop:pick',async()=>{
    const selected=controller.state.selection;if(!selected||controller.state.phase!=='ready')throw new Error('Open the selected environment first.');
    const result=await dialog.showOpenDialog(window!,{title:'Choose a Linux project folder',properties:['openDirectory'],...(selected.environment.kind==='wsl'?{defaultPath:`\\\\wsl.localhost\\${selected.environment.distribution}\\home`}:{})});
    if(result.canceled||result.filePaths.length!==1)return null;
    return pickerPath(result.filePaths[0],selected.environment.kind==='wsl'?selected.environment.distribution:undefined);
  });
  handler('desktop:helper',async input=>{
    const ticket=documents.begin();let thaw:(()=>void)|undefined;
    try {
    const action=z.enum(['setup','repair','uninstall']).parse(input);
    const result=await dialog.showMessageBox(window!,{type:'warning',title:'System-install helper',message:`${action==='setup'?'Enable':action==='repair'?'Repair':'Remove'} system-install authority in the selected Linux environment?`,detail:`Environment: ${JSON.stringify(controller.state.selection?.environment)}. OS authentication is required. Approved packages may run root scripts. Removal preserves installed packages, audit and your data.`,buttons:['Cancel','Continue to OS authentication'],defaultId:0,cancelId:0});
    if(result.response!==1)return {...documents.status(controller.state),message:'Helper operation cancelled. Existing authority is unchanged.'};
    documents.check(ticket);thaw=await freezeWindow(ticket);
    return await controller.helper(action);
    }finally{thaw?.();documents.end(ticket);}
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'abysSUS',submenu:[{label:'Quit',accelerator:'CmdOrCtrl+Q',click:()=>void closeApp()}]}]));
  app.on('before-quit',event=>{if(!quitting){event.preventDefault();void closeApp();}});
  app.on('window-all-closed',()=>{if(quitting)app.quit();});
  createWindow();
}
