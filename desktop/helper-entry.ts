import { lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { PackageHelperClient } from '../server/package-helper.js';
const launcher='/usr/lib/abyssus-helper/launcher';
const absent=async(file:string)=>{try{await lstat(file);return false;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return true;throw e;}};
export async function trustedHelper() {
  for(const p of ['/','/usr','/usr/lib','/usr/lib/abyssus-helper',launcher,'/usr/bin','/usr/bin/pkexec']) {
    const s=await lstat(p);if(s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)!==0)throw new Error('Untrusted helper staging');
  }
}
export async function helperState() {
  const hello=await (await PackageHelperClient.connect()).hello();
  return {available:true,target:`${hello.target.distribution} ${hello.target.release} (${hello.target.id})`};
}
export async function helperOperation(action:'setup'|'repair'|'uninstall') {
  if(!['setup','repair','uninstall'].includes(action)||process.platform!=='linux'||!process.getuid?.())throw new Error('Unsupported helper operation');
  await trustedHelper();
  let before:string|undefined;
  if(action!=='setup')try{before=(await PackageHelperClient.connect()).installationId();}catch{/* OS-authenticated repair/removal must recover a missing or damaged client descriptor. */}
  // OS agent owns authentication. No stdin, passwords, arbitrary env or shell.
  await new Promise<void>((resolve,reject)=>{
    const child=spawn('/usr/bin/pkexec',[launcher,action,...(action==='setup'?[String(process.getuid!())]:[])],
      {cwd:'/',env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',...(process.env.DISPLAY?{DISPLAY:process.env.DISPLAY}:{}),...(process.env.XAUTHORITY?{XAUTHORITY:process.env.XAUTHORITY}:{})},stdio:'ignore'});
    child.once('error',()=>reject(new Error('OS authentication unavailable')));
    // Never timeout-kill elevated work. Cancellation/denial is an actual OS result.
    child.once('exit',code=>code===0?resolve():reject(new Error(`OS authentication cancelled, denied or operation failed (exit ${code})`)));
  });
  if(action==='uninstall') {
    for(const file of [launcher,'/etc/abyssus-helper/client.json','/etc/systemd/system/abyssus-helper.service','/run/abyssus-helper/control.sock'])if(!await absent(file))throw new Error('Helper removal incomplete');
    return {available:false};
  }
  for(let i=0;i<20;i++) {
    try {
      const hello=await (await PackageHelperClient.connect()).hello();
      if(before&&hello.target.installationId!==before)throw new Error('Helper identity changed');
      return {available:true,target:`${hello.target.distribution} ${hello.target.release} (${hello.target.id})`};
    }catch{if(i===19)throw new Error('Helper identity could not be verified after operation');await new Promise(r=>setTimeout(r,500));}
  }
  throw new Error('Helper identity unavailable');
}
if(process.argv[1]?.endsWith('helper-entry.js')) {
  const action=process.argv[2];
  try {
    const result=action==='status'?await helperState():await helperOperation(action as 'setup'|'repair'|'uninstall');
    process.stdout.write(JSON.stringify(result)+'\n');
  }catch{process.stdout.write(JSON.stringify({available:false,error:'Helper unavailable or OS operation was cancelled/failed. Trusted staging, systemd and an OS authentication agent are required.'})+'\n');process.exitCode=1;}
}
