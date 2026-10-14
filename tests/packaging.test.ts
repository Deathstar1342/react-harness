import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {validateLocation}=require('../desktop/bootstrap.cjs') as {validateLocation:(v:string,i:string)=>string};
const {parseLocation}=require('../desktop/bootstrap.cjs') as {parseLocation:(v:Buffer)=>string};
describe('Windows packaged bootstrap data isolation',()=>{
  it.each(['receipt','location','payload'])('rejects a controlled maintenance/startup %s race before importing main',change=>{
    const root=mkdtempSync(path.join(tmpdir(),'abyssus-startup-race-'));
    try {
      const files=['resources/app/desktop/entry.cjs','resources/app/desktop/main.js','resources/app/desktop/package-lease.node'];
      const hashes:Record<string,string>={};
      for(const name of files){mkdirSync(path.dirname(path.join(root,name)),{recursive:true});writeFileSync(path.join(root,name),'fixture');hashes[name]=createHash('sha256').update('fixture').digest('hex');}
      const receipt=path.join(root,'package-integrity.json');writeFileSync(receipt,JSON.stringify(hashes));
      const module={exports:{} as {configure:unknown}};
      const fixtureProcess={platform:'linux',execPath:path.join(root,'abysSUS'),env:{}};
      runInNewContext(readFileSync('desktop/bootstrap.cjs','utf8'),{require,module,process:fixtureProcess,TextDecoder});
      let acquired=false,imported=false,exit:number|undefined,diagnostic='';
      const app={isPackaged:true,requestSingleInstanceLock:()=>true,exit:(code:number)=>{exit=code;}};
      runInNewContext(readFileSync('desktop/entry.cjs','utf8'),{
        process:fixtureProcess,console,
        require:(name:string)=>{
          if(name==='electron')return {app,dialog:{showErrorBox:(_title:string,message:string)=>{diagnostic=message;}}};
          if(name==='./bootstrap.cjs')return module.exports;
          if(name==='./package-lease.node'){
            // Deterministically finish maintenance between the initial snapshot and lease acquisition.
            acquired=true;
            if(change==='receipt')writeFileSync(receipt,JSON.stringify(hashes,null,2));
            if(change==='location')writeFileSync(path.join(root,'desktop-location.ini'),'changed selection');
            if(change==='payload')writeFileSync(path.join(root,files[1]),'changed main');
            return {held:true};
          }
          return require(name);
        },
      },{importModuleDynamically:()=>{imported=true;throw new Error('Main must not import after a startup race');}});
      expect(acquired).toBe(true);expect(exit).toBe(1);expect(imported).toBe(false);
      expect(diagnostic).toMatch(/changed/);
    }finally{rmSync(root,{recursive:true,force:true});}
  });
  it('accepts only a bounded complete location record and rejects malformed/truncated/extra fields',()=>{
    expect(parseLocation(Buffer.from('[desktop]\r\npath=D:\\saved\r\n'))).toBe('D:\\saved');
    expect(parseLocation(Buffer.concat([Buffer.from([255,254]),Buffer.from('[desktop]\r\npath=D:\\saved\r\n','utf16le')]))).toBe('D:\\saved');
    expect(parseLocation(Buffer.concat([Buffer.from([255,254]),Buffer.from('\r\n[desktop]\r\npath=D:\\saved\r\n','utf16le')]))).toBe('D:\\saved');
    for(const bytes of [Buffer.from('\n\n[desktop]\npath=D:\\saved'),Buffer.from('[desktop]\npath=D:\\saved\nextra=yes'),Buffer.from('[desktop]\npath='),Buffer.alloc(2049),Buffer.from([255,254,65]),Buffer.from([255])])expect(()=>parseLocation(bytes)).toThrow();
  });
  it.skipIf(process.platform!=='win32')('reads the actual Windows INI API output used by NSIS without relaxing extra-field rejection',()=>{
    const root=mkdtempSync(path.join(tmpdir(),'abyssus-ini-')),file=path.join(root,'location.ini');
    try {
      const code=`Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class IniWriter { [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool WritePrivateProfileString(string section,string key,string value,string file); }'; [IO.File]::WriteAllBytes($env:ABYSSUS_INI_FIXTURE,[byte[]](255,254)); if(-not [IniWriter]::WritePrivateProfileString('desktop','path','D:\\saved',$env:ABYSSUS_INI_FIXTURE)){exit 1}`;
      const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{env:{...process.env,ABYSSUS_INI_FIXTURE:file},windowsHide:true});
      expect(result.status).toBe(0);expect(parseLocation(readFileSync(file))).toBe('D:\\saved');
    }finally{rmSync(root,{recursive:true,force:true});}
  });
  it.each(['C:\\','\\\\server\\share','\\\\?\\C:\\data','C:\\a\\..\\data','C:\\data:stream','C:\\bad.\\data','relative'])('rejects unsafe location %s',value=>{expect(()=>validateLocation(value,'C:\\Windows')).toThrow();});
  it.skipIf(process.platform!=='win32')('probes an existing separate folder; refuses missing and overlapping folders',()=>{
    const root=mkdtempSync(path.join(tmpdir(),'abyssus-bootstrap-'));mkdirSync(path.join(root,'install'));mkdirSync(path.join(root,'data'));
    try{expect(validateLocation(path.join(root,'data'),path.join(root,'install'))).toBeTruthy();expect(()=>validateLocation(path.join(root,'missing'),path.join(root,'install'))).toThrow();expect(()=>validateLocation(root,path.join(root,'install'))).toThrow();}
    finally{rmSync(root,{recursive:true,force:true});}
  });
  it.skipIf(process.platform!=='win32')('installer rejects roots, protected paths, junction overlap and missing saved data before creating a destination',()=>{
    const root=mkdtempSync(path.join(tmpdir(),'abyssus-setup-')),install=path.join(root,'install');mkdirSync(install);
    const run=(data:string,previous='')=>spawnSync(path.join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('packaging/windows-preflight.ps1'),'-DataFolder',data,'-InstallFolder',install,'-PreviousFolder',previous],{encoding:'utf8',windowsHide:true});
    try {
      for(const data of ['C:\\',process.env.SystemRoot!,process.env.ProgramW6432??process.env.ProgramFiles!,path.join(install,'data')])expect(run(data).status).toBe(76);
      const x86=path.join(process.env.SystemRoot!,'SysWOW64/WindowsPowerShell/v1.0/powershell.exe');
      if(existsSync(x86))expect(spawnSync(x86,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('packaging/windows-preflight.ps1'),'-DataFolder',process.env.ProgramW6432??process.env.ProgramFiles!,'-InstallFolder',install],{encoding:'utf8',windowsHide:true}).status).toBe(76);
      symlinkSync(install,path.join(root,'alias'),'junction');expect(run(path.join(root,'alias','data')).status).toBe(76);
      expect(existsSync(path.join(install,'data'))).toBe(false);
      const missing=path.join(root,'missing');expect(run(missing,missing).status).toBe(76);expect(existsSync(missing)).toBe(false);
      expect(run(path.join(root,'data')).status).toBe(0);expect(existsSync(path.join(root,'data'))).toBe(true);
    }finally{rmSync(root,{recursive:true,force:true});}
  },30000);
});
