import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export async function packageLease() {
  const child=process.platform==='linux'?spawn('/usr/lib/abyssus/launch-lease',[],{stdio:['pipe','pipe','ignore']}):spawn(path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./windows-lease.ps1',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','ignore']});
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Package maintenance lease unavailable; setup cannot continue.')),10000);
    child.once('error',()=>{clearTimeout(timer);reject(new Error('Package maintenance lease unavailable.'));});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Another app or package maintenance operation owns this installation. Close it normally, then retry.'));});
    child.stdout.once('data',data=>{clearTimeout(timer);data.toString().trim()==='ready'?resolve():reject(new Error('Invalid package lease response.'));});
  });
  return child;
}
