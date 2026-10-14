import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { z } from 'zod';
import { DesktopController } from './controller.js';
import { desktopOrigin, environmentSchema, isDesktopURL, linuxPath, pickerPath, validateSender } from './policy.js';
import { desktopResponse } from './proxy.js';
const appRoot=fileURLToPath(new URL('../',import.meta.url));
app.setName('abysSUS');
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{scheme:'abyssus',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,allowServiceWorkers:false}}]);
let window:BrowserWindow|undefined,quitting=false,closing=false,dirty=false;
const controller=new DesktopController(appRoot);
const selectionSchema=z.object({environment:environmentSchema,home:linuxPath}).strict();
if(!app.requestSingleInstanceLock())app.quit();
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
    try{return await desktopResponse(request,path.join(appRoot,'dist/client'),controller.target());}
    catch{return Response.json({error:'Desktop connection failed. Reopen setup to inspect recovery.'},{status:503});}
  });
  const selectionFile=path.join(app.getPath('userData'),'desktop-selection.json');
  if(existsSync(selectionFile))try{controller.state.selection=selectionSchema.parse(JSON.parse(readFileSync(selectionFile,'utf8')));}
  catch{controller.state.message='Saved desktop selection needs recovery. Choose the existing profile explicitly; do not initialize a replacement.';}
  await controller.inventory();
  const createWindow=()=>{
    window=new BrowserWindow({width:1350,height:880,minWidth:740,minHeight:520,title:'abysSUS',backgroundColor:'#171717',show:false,
      webPreferences:{partition:'abyssus-desktop',preload:path.join(appRoot,'desktop/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInWorker:false,webviewTag:false,webSecurity:true,allowRunningInsecureContent:false,devTools:false}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    window.webContents.on('will-redirect',event=>event.preventDefault());
    window.webContents.on('will-attach-webview',event=>event.preventDefault());
    window.webContents.on('will-prevent-unload',()=>{}); // dirty editor veto remains effective
    window.webContents.on('render-process-gone',()=>{
      dirty=true; // Cannot prove unsaved renderer buffers survived a crash.
      void dialog.showMessageBox(window!,{type:'warning',title:'Window stopped',message:'The window stopped. Backend work remains tracked.',detail:'Unsaved editor text may have been lost. Reopen the window to inspect recorded state; actions are not replayed.',buttons:['Keep open','Reopen window'],defaultId:0,cancelId:0}).then(result=>{if(result.response===1){dirty=false;void window?.loadURL(desktopOrigin+'/');}});
    });
    window.on('close',event=>{if(!quitting){event.preventDefault();void closeApp();}});
    window.once('ready-to-show',()=>window?.show());
    void window.loadURL(desktopOrigin+'/');
  };
  async function closeApp() {
    if(closing||!window)return;closing=true;
    try {
      const result=await dialog.showMessageBox(window,{type:'question',title:'Close abysSUS?',message:dirty?'Unsaved editor changes will be lost.':'Close abysSUS and stop its backend?',detail:'Active tools and system-install calls must finish local cleanup. System changes are not rolled back. Recorded uncertain outcomes remain for review.',buttons:['Keep open','Close and wait'],defaultId:0,cancelId:0});
      if(result.response!==1)return;
      await controller.stop();quitting=true;window.destroy();app.quit();
    }catch{await dialog.showMessageBox(window,{type:'error',message:'Backend shutdown is not confirmed.',detail:'The window and ownership remain active. Allow local cleanup to finish; no process was killed and no install was replayed.'});}
    finally{closing=false;}
  }
  const handler=(channel:string,fn:(input:unknown)=>unknown)=>ipcMain.handle(channel,(event,input)=>{validateSender(event,window?.webContents);return fn(input);});
  handler('desktop:status',()=>controller.state);
  handler('desktop:dirty',input=>{dirty=z.boolean().parse(input);});
  handler('desktop:start',async input=>{
    if(dirty)throw new Error('Save or discard the editor buffer before changing desktop setup.');
    const {startSchema}=await import('./policy.js');const selected=startSchema.parse(input);
    const confirmed=await dialog.showMessageBox(window!,{type:'question',message:`${selected.mode==='initialize'?'Initialize':'Open'} the selected Linux profile?`,detail:`Environment: ${JSON.stringify(selected.environment)}\nProfile: ${selected.home}${selected.legacyRoot?'\nLegacy source: '+selected.legacyRoot+'\nStop every old backend before migration.':''}`,buttons:['Cancel','Continue'],defaultId:0,cancelId:0});
    if(confirmed.response!==1)return {...controller.state,message:'Profile selection cancelled.'};
    const result=await controller.start(input);
    mkdirSync(path.dirname(selectionFile),{recursive:true});
    const temporary=selectionFile+'.tmp';writeFileSync(temporary,JSON.stringify(result.selection),{mode:0o600});renameSync(temporary,selectionFile);
    return result;
  });
  handler('desktop:pick',async()=>{
    const selected=controller.state.selection;if(!selected||controller.state.phase!=='ready')throw new Error('Open the selected environment first.');
    const result=await dialog.showOpenDialog(window!,{title:'Choose a Linux project folder',properties:['openDirectory'],...(selected.environment.kind==='wsl'?{defaultPath:`\\\\wsl.localhost\\${selected.environment.distribution}\\home`}:{})});
    if(result.canceled||result.filePaths.length!==1)return null;
    return pickerPath(result.filePaths[0],selected.environment.kind==='wsl'?selected.environment.distribution:undefined);
  });
  handler('desktop:helper',async input=>{
    if(dirty)throw new Error('Save or discard unsaved edits before helper maintenance.');
    const action=z.enum(['setup','repair','uninstall']).parse(input);
    const result=await dialog.showMessageBox(window!,{type:'warning',title:'System-install helper',message:`${action==='setup'?'Enable':action==='repair'?'Repair':'Remove'} system-install authority in the selected Linux environment?`,detail:`Environment: ${JSON.stringify(controller.state.selection?.environment)}. OS authentication is required. Approved packages may run root scripts. Removal preserves installed packages, audit and your data.`,buttons:['Cancel','Continue to OS authentication'],defaultId:0,cancelId:0});
    if(result.response!==1)return {...controller.state,message:'Helper operation cancelled. Existing authority is unchanged.'};
    return controller.helper(action);
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'abysSUS',submenu:[{label:'Quit',click:()=>void closeApp()}]}]));
  app.on('before-quit',event=>{if(!quitting){event.preventDefault();void closeApp();}});
  app.on('window-all-closed',()=>{if(quitting)app.quit();});
  createWindow();
}
