// Disposable sandboxed renderer host. Not installed/native-container acceptance.
const {app,BrowserWindow}=require('electron');
const path=require('node:path');
if(!process.env.M34_ELECTRON_HOME||!process.env.M34_URL)throw new Error('Explicit disposable output paths required');
app.setPath('userData',process.env.M34_ELECTRON_HOME);app.setPath('sessionData',path.join(process.env.M34_ELECTRON_HOME,'session'));app.setPath('crashDumps',path.join(process.env.M34_ELECTRON_HOME,'crashes'));
app.whenReady().then(()=>{const window=new BrowserWindow({width:1440,height:1000,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});globalThis.__m34Paints=0;window.webContents.on('paint',()=>{globalThis.__m34Paints++;});window.webContents.setFrameRate(30);window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.loadURL(process.env.M34_URL);});
app.on('window-all-closed',()=>app.quit());
