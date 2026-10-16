import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, realpathSync, lstatSync, readdirSync } from 'node:fs';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { DocumentGuard } from './document-guard.js';
import { ContainerDesktopController } from './container-controller.js';
import { hostStoragePath } from '../server/container-contract.js';
import { desktopOrigin, isDesktopURL, validateSender } from './policy.js';
import { desktopResponse } from './proxy.js';
const appRoot=fileURLToPath(new URL('../',import.meta.url));
app.setName('abysSUS');
nativeTheme.themeSource='dark';
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{scheme:'abyssus',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,allowServiceWorkers:false}}]);
let window:BrowserWindow|undefined,quitting=false,closing=false;
const documents=new DocumentGuard();
const controller=new ContainerDesktopController(appRoot);
let picked:{id:string;path:string;storageId:string;mode:'existing'|'initialize'}|undefined;
const selectionSchema=z.object({path:z.string().max(4096),storageId:z.uuid()}).strict();
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
  const selectionFile=path.join(app.getPath('userData'),'desktop-container-selection.json');
  if(existsSync(selectionFile))try{controller.selection=selectionSchema.parse(JSON.parse(readFileSync(selectionFile,'utf8')));controller.state.container={available:false,storage:{displayPath:controller.selection.path,id:controller.selection.storageId}};}
  catch{controller.state.message='Saved desktop selection needs recovery. Choose the existing profile explicitly; do not initialize a replacement.';}
  await controller.inventory();

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
  handler('desktop:container-check',async()=>{if(documents.busy)throw new Error('Wait for the current transition.');return controller.inventory();});
  handler('desktop:storage-pick',async()=>{
    const ticket=documents.begin();
    try {
      if(controller.state.phase==='ready')throw new Error('Stop the current workspace before selecting other storage.');
      const result=await dialog.showOpenDialog(window!,{title:'Choose persistent abysSUS storage',properties:['openDirectory','createDirectory']});
      documents.check(ticket);if(result.canceled||result.filePaths.length!==1)return null;
      if(process.platform!=='linux'&&process.platform!=='win32')throw new Error('Unsupported desktop platform.');
      const selected=hostStoragePath(result.filePaths[0],process.platform);
      if(lstatSync(selected).isSymbolicLink()||realpathSync(selected)!==selected)throw new Error('Choose a canonical local folder without links.');
      const marker=path.join(selected,'.storage-id');
      const mode=existsSync(marker)?'existing':'initialize';
      if(mode==='initialize'&&readdirSync(selected).length)throw new Error('New storage must be an empty folder. Existing data was preserved.');
      const storageId=mode==='existing'?z.uuid().parse(readFileSync(marker,'utf8').trim()):randomUUID();
      picked={id:randomUUID(),path:selected,storageId,mode};return {id:picked.id,displayPath:selected,mode};
    }finally{documents.end(ticket);}
  });
  handler('desktop:container-start',async input=>{
    const choice=z.object({selectionId:z.uuid().optional()}).strict().parse(input);
    const selected=choice.selectionId?(picked?.id===choice.selectionId?picked:undefined):controller.selection?{...controller.selection,mode:'existing' as const}:undefined;
    if(!selected)throw new Error('Choose storage with the native folder picker.');
    const ticket=documents.begin();let thaw:(()=>void)|undefined;
    try {
      const result=await dialog.showMessageBox(window!,{type:'question',title:'Open persistent storage',message:selected.mode==='initialize'?'Initialize this empty app storage folder?':'Open this existing app storage?',detail:selected.path+'\nProjects, chats, settings and dependencies stay here. Docker images and engine cache use separate engine storage; this choice does not relocate them.',buttons:['Cancel','Open workspace'],defaultId:0,cancelId:0});
      if(result.response!==1)return documents.status(controller.state);
      documents.check(ticket);thaw=await freezeWindow(ticket);
      // Persist the deliberate selection before launch, preserving partial setup for recovery.
      mkdirSync(path.dirname(selectionFile),{recursive:true});
      const temporary=selectionFile+'.tmp';writeFileSync(temporary,JSON.stringify({path:selected.path,storageId:selected.storageId}),{mode:0o600});renameSync(temporary,selectionFile);
      const previous=documents.sessionId;
      const status=await controller.start({path:selected.path,storageId:selected.storageId},selected.mode);
      documents.check(ticket);documents.publish(status);picked=undefined;
      if(previous&&previous!==status.sessionId){window!.destroy();createWindow();}
      return status;
    }finally{thaw?.();documents.end(ticket);}
  });
  handler('desktop:container-restart',async()=>{
    const ticket=documents.begin();let thaw:(()=>void)|undefined;
    try {
      if(!controller.selection)throw new Error('Open storage first.');
      const answer=await dialog.showMessageBox(window!,{type:'question',message:'Restart the owned runtime?',detail:'Waits for active work and installs to drain. Persistent data remains; goals and uncertain work do not replay.',buttons:['Cancel','Restart'],defaultId:0,cancelId:0});
      if(answer.response!==1)return documents.status(controller.state);
      documents.check(ticket);thaw=await freezeWindow(ticket);await controller.stop();documents.check(ticket);
      const status=await controller.start(controller.selection,'existing');documents.check(ticket);documents.publish(status);window!.destroy();createWindow();return status;
    }finally{thaw?.();documents.end(ticket);}
  });
  handler('desktop:transfer',async input=>{
    const selection=z.discriminatedUnion('kind',[z.object({kind:z.literal('import')}).strict(),z.object({kind:z.literal('export'),projectId:z.uuid()}).strict()]).parse(input);
    const ticket=documents.begin();let handle:string|undefined;
    try {
      const target=controller.target();if(!target||target.sessionId!==documents.sessionId)throw new Error('Open the current workspace first.');
      let project:string|null=null;
      if(selection.kind==='export'){
        const response=await fetch(target.address+'/api/projects',{headers:{authorization:'Bearer '+target.token},redirect:'error',signal:AbortSignal.timeout(5000)});
        if(!response.ok)throw new Error('Managed project identity could not be checked.');
        const projects=z.array(z.object({id:z.uuid(),path:z.string()})).parse(await response.json());
        const match=projects.find(item=>item.id===selection.projectId);if(!match||!/^\/workspace\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(match.path))throw new Error('Choose a registered managed project.');project=path.posix.basename(match.path);
      }
      const choice=selection.kind==='import'?await dialog.showOpenDialog(window!,{title:'Import a one-time project copy',properties:['openDirectory']}):await dialog.showSaveDialog(window!,{title:'Export to a new folder',defaultPath:'project-export',buttonLabel:'Choose new destination'});
      documents.check(ticket);if(choice.canceled)return null;
      const selected='filePaths' in choice?choice.filePaths[0]:choice.filePath;if(!selected)return null;
      const history=await dialog.showMessageBox(window!,{type:'question',message:'Choose Git history for this copy',detail:'Working files preserve your current edits. Git history may contain deleted secrets. Dependency/build caches and sensitive configuration files are excluded; no source files are modified.',buttons:['Cancel','Working files only','Include safe Git history'],defaultId:1,cancelId:0});
      documents.check(ticket);if(history.response===0)return null;
      const review=await controller.selectTransfer({kind:selection.kind,path:selected,project,included:[],history:history.response===2});handle=review.handle;
      const confirmed=await dialog.showMessageBox(window!,{type:'question',message:`Copy ${review.files} entries (${review.bytes} bytes)?`,detail:selected+'\n'+review.excludedCount+' excluded entries.\n'+review.excluded.map(item=>item.path+': '+item.reason).join('\n'),buttons:['Cancel','Authorize copy'],defaultId:0,cancelId:0});
      documents.check(ticket);if(confirmed.response!==1)return null;
      const authorized=await controller.authorizeTransfer(handle);handle=undefined;return authorized;
    }finally{if(handle)await controller.discardTransfer(handle).catch(()=>{});documents.end(ticket);}
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'abysSUS',submenu:[{label:'Quit',accelerator:'CmdOrCtrl+Q',click:()=>void closeApp()}]}]));
  app.on('before-quit',event=>{if(!quitting){event.preventDefault();void closeApp();}});
  app.on('window-all-closed',()=>{if(quitting)app.quit();});
  createWindow();
}
