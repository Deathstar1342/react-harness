const fs=require('node:fs/promises');
const path=require('node:path');
module.exports=async context=>{
  if(context.electronPlatformName==='win32')return;
  const {manifest}=await import('./package-manifest.mjs');
  // Write last; a partial installer extraction cannot masquerade as complete.
  await fs.writeFile(path.join(context.appOutDir,'package-integrity.json'),JSON.stringify(await manifest(context.appOutDir)));
};
