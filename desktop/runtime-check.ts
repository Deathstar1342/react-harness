import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { boundedProcess } from './process.js';
const require=createRequire(import.meta.url);
export async function runtimeChecks() {
  const checks:{name:string;ok:boolean;message:string}[]=[];
  const check=async(name:string,run:()=>unknown|Promise<unknown>,help:string)=>{try{await run();checks.push({name,ok:true,message:'Available'});}catch{checks.push({name,ok:false,message:help});}};
  await check('Supported Linux',()=>{
    if(process.platform!=='linux'||process.arch!=='x64'||!process.getuid?.())throw new Error();
    const release=readFileSync('/etc/os-release','utf8');
    if(!/^ID=(?:"?ubuntu"?|"?debian"?)$/m.test(release))throw new Error();
  },'Select non-root Ubuntu or Debian x64. Other environments are unsupported.');
  await check('Dedicated Node and SQLite',()=>{
    if(Number(process.versions.node.split('.')[0])<24)throw new Error();
    const node=realpathSync(process.execPath),manifest=JSON.parse(readFileSync(path.resolve(node,'../../manifest.json'),'utf8'));
    if(manifest.nodeVersion!==process.versions.node||manifest.modules!==process.versions.modules||manifest.platform!==process.platform||manifest.arch!==process.arch||manifest.nodeSha256!==createHash('sha256').update(readFileSync(node)).digest('hex'))throw new Error();
    const db=new DatabaseSync(':memory:');try{db.prepare('SELECT 1').get();}finally{db.close();}
  },'Repair the packaged Node 24+ backend runtime. Electron Node is not used.');
  await check('Native PTY',async()=>{
    const pty=require('node-pty') as {spawn:(file:string,args:string[],options:object)=>{onData:(cb:(s:string)=>void)=>void;onExit:(cb:(e:{exitCode:number})=>void)=>void;kill:()=>void}};
    await new Promise<void>((resolve,reject)=>{
      const child=pty.spawn('/usr/bin/printf',['abyssus-pty-ready'],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},cwd:'/'});let output='';
      const timer=setTimeout(()=>{child.kill();reject(new Error());},5000);
      child.onData(chunk=>{output+=chunk;});child.onExit(event=>{clearTimeout(timer);event.exitCode===0&&output==='abyssus-pty-ready'?resolve():reject(new Error());});
    });
  },'Repair Linux node-pty built for the dedicated Node runtime ABI.');
  await check('Sandbox namespaces',()=>boundedProcess('/usr/bin/bwrap',['--unshare-all','--unshare-user','--disable-userns','--die-with-parent','--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64','--proc','/proc','--dev','/dev','--','/usr/bin/true'],{env:{PATH:'/usr/bin:/bin'}}),
    'Bubblewrap/user namespaces are unavailable. Ask your administrator to configure this environment. Host execution stays disabled.');
  await check('Toolchain and registry bridge',async()=>{
    for(const f of ['/usr/bin/bash','/usr/bin/socat','/usr/bin/git','/usr/bin/python3'])if(!existsSync(f))throw new Error();
    await boundedProcess('/usr/bin/python3',['-I','-c','import venv, ensurepip'],{env:{PATH:'/usr/bin:/bin'}});
  },'Install bash, socat, git, python3 and python3-venv through your administrator.');
  await check('Optional system installs',()=>{
    if(!existsSync('/run/systemd/system')||!existsSync('/usr/lib/abyssus-helper/launcher'))throw new Error();
  },'Optional: systemd and the administrator-staged abysSUS helper are required. Ordinary safe app use remains available.');
  return checks;
}
