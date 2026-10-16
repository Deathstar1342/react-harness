import Fastify from 'fastify';
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {NativeBindPolicy} from '../server/native-bind-policy.js';
afterEach(()=>{vi.resetModules();});
it('actual private writes refuse missing host scope and lost replies before creating files',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'native-hooks-')),filename=path.join(root,'private.json'),record={storageId:randomUUID(),launchId:randomUUID()};
 const policy={record,verifyRoots:vi.fn(),permits:vi.fn((file:string)=>file===root||file.startsWith(root+path.sep))} as unknown as NativeBindPolicy;
 const check=vi.fn(async()=>({...record,gateId:'a'.repeat(64),issuedAt:Date.now(),expiresAt:Date.now()+5000}));
 const authority=await import('../server/native-storage.js');authority.installNativeStorage(policy,check);
 // Native Linux container paths use POSIX syntax; local fixture replaces only
 // the lexical platform parser, leaving actual writes and gate checks intact.
 const hostDirname=path.dirname.bind(path),dirname=process.platform==='win32'?vi.spyOn(path.posix,'dirname').mockImplementation(hostDirname):undefined;
 const absolute=process.platform==='win32'?vi.spyOn(path.posix,'isAbsolute').mockReturnValue(true):undefined,normalize=process.platform==='win32'?vi.spyOn(path.posix,'normalize').mockImplementation(value=>value):undefined;
 try{
  const {durableWrite}=await import('../server/profile.js');
  expect(()=>durableWrite(filename,'unscoped')).toThrow(/freshness/);expect(existsSync(filename)).toBe(false);
  await authority.runNativeOperation(()=>durableWrite(filename,'authorized'));expect(readFileSync(filename,'utf8')).toBe('authorized');
  check.mockRejectedValueOnce(new Error('lost host reply'));
  await expect(authority.runNativeOperation(()=>durableWrite(filename,'replayed'))).rejects.toThrow('lost host reply');
  await expect(authority.runNativeOperation(()=>durableWrite(filename,'retry'))).rejects.toThrow(/recovery/);expect(readFileSync(filename,'utf8')).toBe('authorized');
 }finally{absolute?.mockRestore();normalize?.mockRestore();dirname?.mockRestore();}
});

it('real Fastify async routes retain scope across done and await, then refuse an expired pending write',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'native-http-')),filename=path.join(root,'private.json'),record={storageId:randomUUID(),launchId:randomUUID()};let clock=Date.now();
 const date=vi.spyOn(Date,'now').mockImplementation(()=>clock),hostDirname=path.dirname.bind(path),dirname=process.platform==='win32'?vi.spyOn(path.posix,'dirname').mockImplementation(hostDirname):undefined,absolute=process.platform==='win32'?vi.spyOn(path.posix,'isAbsolute').mockReturnValue(true):undefined,normalize=process.platform==='win32'?vi.spyOn(path.posix,'normalize').mockImplementation(value=>value):undefined;
 const authority=await import('../server/native-storage.js'),{durableWrite}=await import('../server/profile.js');
 const check=vi.fn(async()=>({...record,gateId:'b'.repeat(64),issuedAt:clock,expiresAt:clock+10000}));
 const policy={record,verifyRoots:vi.fn(),permits:vi.fn((file:string)=>file===root||file.startsWith(root+path.sep))} as unknown as NativeBindPolicy;
 authority.installNativeStorage(policy,check);const app=Fastify();authority.registerNativeStorageScope(app);
 app.post('/write',async()=>{await Promise.resolve();durableWrite(filename,'async success');return {saved:true};});
 app.post('/delayed',async()=>{await Promise.resolve();clock+=10001;durableWrite(filename,'stale write');return {saved:true};});
 try{
  expect((await app.inject({method:'POST',url:'/write'})).statusCode).toBe(200);expect(readFileSync(filename,'utf8')).toBe('async success');
  expect((await app.inject({method:'POST',url:'/delayed'})).statusCode).toBe(500);expect(readFileSync(filename,'utf8')).toBe('async success');
  expect((await app.inject({method:'POST',url:'/write'})).statusCode).toBe(500);expect(check).toHaveBeenCalledTimes(2);
 }finally{await app.close();date.mockRestore();absolute?.mockRestore();normalize?.mockRestore();dirname?.mockRestore();}
});
