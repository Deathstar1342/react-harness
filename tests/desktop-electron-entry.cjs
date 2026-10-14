// Dedicated test launcher; never shipped. Isolates Electron's own browser profile.
const {app}=require('electron');
const path=require('node:path');
const {existsSync,writeFileSync}=require('node:fs');
if(!process.env.ABYSSUS_SMOKE_HOME)throw new Error('Disposable smoke home required');
app.setPath('userData',process.env.ABYSSUS_SMOKE_HOME);
// Test-only barriers live in this module, outside Playwright's ephemeral
// inspector evaluation context. Fixed markers stay inside the disposable home.
const hold=async operation=>{
  const marker=path.join(process.env.ABYSSUS_SMOKE_HOME,'hold-'+operation);
  if(!existsSync(marker))return;
  writeFileSync(path.join(process.env.ABYSSUS_SMOKE_HOME,'ready-'+operation),'ready');
  while(existsSync(marker))await new Promise(resolve=>setTimeout(resolve,25));
};
import(require('node:url').pathToFileURL(path.resolve(__dirname,'../build/app/desktop/controller.js')).href).then(module=>{
  for(const operation of ['start','stop']){
    const original=module.DesktopController.prototype[operation];
    module.DesktopController.prototype[operation]=async function(...args){
      const result=await original.apply(this,args);await hold(operation);return result;
    };
  }
  return import(require('node:url').pathToFileURL(path.resolve(__dirname,'../build/app/desktop/main.js')).href);
});
