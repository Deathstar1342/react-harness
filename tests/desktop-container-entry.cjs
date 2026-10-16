// Test-only entry. Never copied into the application payload.
const {app}=require('electron');
const path=require('node:path');
// Exercise production main's packaged-state branch, not package/installer acceptance.
Object.defineProperty(app,'isPackaged',{get:()=>true});
if(!process.env.M31_SMOKE_HOME||!process.env.M31_APP_ROOT)throw new Error('Explicit disposable paths required');
for(const name of ['userData','sessionData','cache'])app.setPath(name,process.env.M31_SMOKE_HOME);
void import(require('node:url').pathToFileURL(path.join(process.env.M31_APP_ROOT,'desktop/main.js')).href);
