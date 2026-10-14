// Dedicated test launcher; never shipped. Isolates Electron's own browser profile.
const {app}=require('electron');
const path=require('node:path');
if(!process.env.ABYSSUS_SMOKE_HOME)throw new Error('Disposable smoke home required');
app.setPath('userData',process.env.ABYSSUS_SMOKE_HOME);
// Test-only access lets smoke hold a real lifecycle operation without adding
// debug hooks or bypasses to the shipped preload/main contract.
import(require('node:url').pathToFileURL(path.resolve(__dirname,'../build/app/desktop/controller.js')).href).then(module=>{
  globalThis.m20Controller=module.DesktopController;
  return import(require('node:url').pathToFileURL(path.resolve(__dirname,'../build/app/desktop/main.js')).href);
});
