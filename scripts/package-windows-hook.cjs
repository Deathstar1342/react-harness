const fs=require('node:fs/promises');
const path=require('node:path');
// 26.15.3 emits this hook after editing resources with signExecutable:false.
// The hook name does NOT mean that an unsigned candidate has a signature.
module.exports=async context=>{
  if(context.electronPlatformName!=='win32')return;
  const {manifest}=await import('./package-manifest.mjs');
  await fs.writeFile(path.join(context.appOutDir,'package-integrity.json'),JSON.stringify(await manifest(context.appOutDir)));
};
