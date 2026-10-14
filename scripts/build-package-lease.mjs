import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),output=path.join(root,'build/native');mkdirSync(output,{recursive:true});
if(process.arch!=='x64')throw new Error('Only x64 package lease is supported');
const source=path.join(root,'desktop/package-lease.c'),target=path.join(output,'package-lease.node');
if(process.platform==='win32') {
  const vswhere=path.join(process.env['ProgramFiles(x86)']??'C:/Program Files (x86)','Microsoft Visual Studio/Installer/vswhere.exe');
  const installation=execFileSync(vswhere,['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath'],{encoding:'utf8'}).trim();
  const setup=path.join(installation,'Common7/Tools/VsDevCmd.bat');if(!installation||!existsSync(setup))throw new Error('Windows SDK C compiler is required only to build the release.');
  const quote=v=>{if(/["\r\n]/.test(v))throw new Error('Invalid compiler path');return '"'+v+'"';};
  writeFileSync(path.join(output,'build-lease.cmd'),`@echo off\r\ncall ${quote(setup)} -arch=x64 -host_arch=x64\r\nif errorlevel 1 exit /b 1\r\ncl /nologo /std:c11 /LD /O2 /W4 /WX /wd4191 ${quote(source)} /link /OUT:${quote(target)} kernel32.lib\r\n`);
  execFileSync(process.env.ComSpec??'C:/Windows/System32/cmd.exe',['/d','/c','build-lease.cmd'],{cwd:output,stdio:'inherit'});
}else if(process.platform==='linux')execFileSync('/usr/bin/cc',['-shared','-fPIC','-O2','-Wall','-Wextra','-Werror',source,'-o',target,'-ldl'],{stdio:'inherit'});
else throw new Error('Unsupported package platform');
