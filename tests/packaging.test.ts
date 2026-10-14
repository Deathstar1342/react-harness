import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {validateLocation}=require('../desktop/bootstrap.cjs') as {validateLocation:(v:string,i:string)=>string};
const {parseLocation}=require('../desktop/bootstrap.cjs') as {parseLocation:(v:Buffer)=>string};
describe('Windows packaged bootstrap data isolation',()=>{
  it('accepts only a bounded complete location record and rejects malformed/truncated/extra fields',()=>{
    expect(parseLocation(Buffer.from('[desktop]\r\npath=D:\\saved\r\n'))).toBe('D:\\saved');
    expect(parseLocation(Buffer.concat([Buffer.from([255,254]),Buffer.from('[desktop]\r\npath=D:\\saved\r\n','utf16le')]))).toBe('D:\\saved');
    for(const bytes of [Buffer.from('[desktop]\npath=D:\\saved\nextra=yes'),Buffer.from('[desktop]\npath='),Buffer.alloc(2049),Buffer.from([255,254,65]),Buffer.from([255])])expect(()=>parseLocation(bytes)).toThrow();
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
      for(const data of ['C:\\',process.env.SystemRoot!,path.join(install,'data')])expect(run(data).status).toBe(76);
      symlinkSync(install,path.join(root,'alias'),'junction');expect(run(path.join(root,'alias','data')).status).toBe(76);
      expect(existsSync(path.join(install,'data'))).toBe(false);
      const missing=path.join(root,'missing');expect(run(missing,missing).status).toBe(76);expect(existsSync(missing)).toBe(false);
      expect(run(path.join(root,'data')).status).toBe(0);expect(existsSync(path.join(root,'data'))).toBe(true);
    }finally{rmSync(root,{recursive:true,force:true});}
  },30000);
});
