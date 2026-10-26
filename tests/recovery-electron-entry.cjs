// Disposable renderer host only. This is not packaged/native-container acceptance.
const {app,BrowserWindow}=require('electron');
const path=require('node:path');
if(!process.env.M33_ELECTRON_HOME||!process.env.M33_URL)throw new Error('Explicit disposable D/output paths required');
app.setPath('userData',process.env.M33_ELECTRON_HOME);
app.setPath('sessionData',path.join(process.env.M33_ELECTRON_HOME,'session'));
app.setPath('crashDumps',path.join(process.env.M33_ELECTRON_HOME,'crashes'));
app.whenReady().then(()=>{
  const window=new BrowserWindow({width:1440,height:1000,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.loadURL(process.env.M33_URL);
});
app.on('window-all-closed',()=>app.quit());
