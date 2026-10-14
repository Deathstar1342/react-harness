// Dedicated test launcher; never shipped. Isolates Electron's own browser profile.
const {app}=require('electron');
const path=require('node:path');
if(!process.env.ABYSSUS_SMOKE_HOME)throw new Error('Disposable smoke home required');
app.setPath('userData',process.env.ABYSSUS_SMOKE_HOME);
import(require('node:url').pathToFileURL(path.resolve(__dirname,'../build/app/desktop/main.js')).href);
