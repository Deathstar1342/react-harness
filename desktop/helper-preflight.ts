import { lstat } from 'node:fs/promises';
import { z } from 'zod';
export const helperLauncher='/usr/lib/abyssus-helper/launcher';
const readiness=z.object({canStart:z.boolean(),message:z.string().max(1024)}).strict();
export const helperReadinessSchema=z.object({setup:readiness,repair:readiness,uninstall:readiness}).strict();
export type HelperReadiness=z.infer<typeof helperReadinessSchema>;
export async function trustedHelper() {
  for(const p of ['/','/usr','/usr/lib','/usr/lib/abyssus-helper',helperLauncher,'/usr/bin','/usr/bin/pkexec']) {
    const s=await lstat(p);if(s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)!==0)throw new Error('Untrusted helper staging');
    if(p===helperLauncher||p==='/usr/bin/pkexec'){if(!s.isFile()||(s.mode&0o111)===0)throw new Error('Helper executable unavailable');}
    else if(!s.isDirectory())throw new Error('Invalid helper staging directory');
  }
}
const checks={trusted:trustedHelper,system:async()=>{
  const system=await lstat('/run/systemd/system'),bus=await lstat('/run/dbus/system_bus_socket');
  if(!system.isDirectory()||system.uid!==0||!bus.isSocket()||bus.uid!==0)throw new Error('System services unavailable');
}};
/** Read-only prerequisites, not proof of OS authorization or a successful operation. */
export async function helperPreflight(dependencies=checks):Promise<HelperReadiness> {
  try{await dependencies.trusted();}
  catch{return blocked('Optional helper code or pkexec is missing or not trusted. Ask an administrator to stage the abysSUS helper and OS authentication tools in this Linux environment. Your current workspace stays connected.');}
  try{await dependencies.system();}
  catch{return blocked('Optional system installs require systemd and the system D-Bus service in this Linux environment. Ask an administrator to configure them; you can continue to chats.');}
  const result={canStart:true,message:'Helper staging and service prerequisites are present. OS authentication may require a running graphical polkit agent. Agent registration and authorization are not verified here; cancellation, denial or operation failure remains possible.'};
  // Repair/removal intentionally do not require a readable client descriptor,
  // healthy service, or authenticated hello: they recover those damaged states.
  return {setup:{...result},repair:{...result},uninstall:{...result}};
}
function blocked(message:string):HelperReadiness {return {setup:{canStart:false,message},repair:{canStart:false,message},uninstall:{canStart:false,message}};}
