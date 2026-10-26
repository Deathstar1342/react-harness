// Actual production NativePreview/IPC/policy in a controlled renderer host.
// No Docker, project shell, device setup or live provider is involved.
const {app,BrowserWindow,protocol,session,ipcMain,WebContentsView}=require('electron');const path=require('node:path');const {pathToFileURL}=require('node:url');
for(const key of ['M35_APP_ROOT','M35_TEST_HOME','M35_BACKEND','M35_TOKEN','M35_SESSION'])if(!process.env[key])throw new Error('Explicit fixture paths/identity required');
app.setPath('userData',path.join(process.env.M35_TEST_HOME,'user'));app.setPath('sessionData',path.join(process.env.M35_TEST_HOME,'session'));app.setPath('crashDumps',path.join(process.env.M35_TEST_HOME,'crashes'));app.enableSandbox();
protocol.registerSchemesAsPrivileged([{scheme:'abyssus',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,allowServiceWorkers:false}},{scheme:'abyssus-preview',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,allowServiceWorkers:false}},{scheme:'m35-positive',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.whenReady().then(async()=>{
 const [{NativePreview},{desktopResponse},{validateSender}]=await Promise.all(['desktop/preview.js','desktop/proxy.js','desktop/policy.js'].map(file=>import(pathToFileURL(path.join(process.env.M35_APP_ROOT,file)).href)));
 const target={address:process.env.M35_BACKEND,token:process.env.M35_TOKEN,sessionId:process.env.M35_SESSION};globalThis.m35Backend=target;
 const partition=session.fromPartition('m35-trusted-app');partition.protocol.handle('abyssus',req=>desktopResponse(req,path.join(process.env.M35_APP_ROOT,'dist/client'),target));
 const host=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{partition:'m35-trusted-app',preload:path.join(process.env.M35_APP_ROOT,'desktop/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});globalThis.m35Host=host;
 const previews=new NativePreview(()=>host,()=>globalThis.m35Backend,()=>process.env.M35_SESSION);globalThis.m35Previews=previews;
 const handle=(name,fn)=>ipcMain.handle(name,(event,input)=>{validateSender(event,host.webContents);return fn(input);});
 handle('desktop:status',()=>({runtime:'container',platform:process.platform,phase:'ready',sessionId:process.env.M35_SESSION,distributions:[],message:'Controlled fixture; no real container/device acceptance',container:{available:true}}));handle('desktop:dirty',()=>{});
 handle('desktop:preview-open',input=>previews.open(input));handle('desktop:preview-bounds',input=>previews.move(input));handle('desktop:preview-reload',input=>previews.reload(input));handle('desktop:preview-close',input=>previews.close(input));
 host.webContents.setWindowOpenHandler(()=>({action:'deny'}));await host.loadURL('abyssus://app/');
 const positiveSession=session.fromPartition('m35-positive');positiveSession.protocol.handle('m35-positive',()=>new Response('<title>Unprotected positive control</title>',{headers:{'Content-Type':'text/html'}}));
 const positive=new WebContentsView({webPreferences:{session:positiveSession,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false}});globalThis.m35Positive=positive;host.contentView.addChildView(positive);positive.setBounds({x:0,y:0,width:50,height:50});await positive.webContents.loadURL('m35-positive://control/');host.contentView.removeChildView(positive);
});
app.on('window-all-closed',()=>app.quit());
