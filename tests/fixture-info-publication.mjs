// Deterministic real-filesystem publication interleavings; no Docker or app runtime.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {publishFixtureInfo} from './fixture-info.mjs';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'fixture-info-publication-')),destination=path.join(directory,'info.json');
const original={instance:'original',starts:1},next={instance:'replacement',starts:0};
try {
 for(const [value,previous] of [[original,undefined],[next,original]]) {
  let reached,release;const paused=new Promise(resolve=>reached=resolve),resume=new Promise(resolve=>release=resolve);
  const io={...fs,open:async(file,flags,mode)=>{
   assert.equal(path.dirname(file),directory);assert.equal(flags,'wx');assert.equal(mode,0o600);
   const handle=await fs.open(file,flags,mode);
   return {writeFile:async text=>{const split=Math.floor(text.length/2);await handle.writeFile(text.slice(0,split));reached(file);await resume;await handle.writeFile(text.slice(split));},sync:()=>handle.sync(),close:()=>handle.close()};
  }};
  const pending=publishFixtureInfo(destination,value,io),temporary=await paused;
  const partial=await fs.readFile(temporary,'utf8');assert(partial.length>0);assert.throws(()=>JSON.parse(partial));
  if(previous)assert.deepEqual(JSON.parse(await fs.readFile(destination,'utf8')),previous);
  else await assert.rejects(fs.readFile(destination),{code:'ENOENT'});
  release();await pending;assert.deepEqual(JSON.parse(await fs.readFile(destination,'utf8')),value);
  assert.deepEqual(await fs.readdir(directory),['info.json']);
  if(process.platform!=='win32')assert.equal((await fs.stat(destination)).mode&0o777,0o600);
 }
 const failure={...fs,open:async(...args)=>{const handle=await fs.open(...args);return {writeFile:async()=>{await handle.writeFile('{');throw Error('controlled write failure');},close:()=>handle.close()};}};
 await assert.rejects(publishFixtureInfo(destination,{instance:'failed'},failure),/controlled write failure/);
 assert.deepEqual(JSON.parse(await fs.readFile(destination,'utf8')),next);assert.deepEqual(await fs.readdir(directory),['info.json']);
 const renameFailure={...fs,rename:async()=>{throw Error('controlled rename failure');}};
 await assert.rejects(publishFixtureInfo(destination,{instance:'failed rename'},renameFailure),/controlled rename failure/);
 assert.deepEqual(JSON.parse(await fs.readFile(destination,'utf8')),next);assert.deepEqual(await fs.readdir(directory),['info.json']);
 const result={...(process.env.GITHUB_SHA?{source:process.env.GITHUB_SHA}:{}),passed:true,checks:['initial partial temp never published','replacement preserves complete original until rename','complete replacement visible after rename','private exclusive same-directory temp','failed write preserves original and removes owned temp','failed rename preserves original and removes owned temp']};
 if(process.env.M35_PUBLICATION_RECEIPT){const receipt=process.env.M35_PUBLICATION_RECEIPT;await fs.mkdir(path.dirname(receipt),{recursive:true});await fs.writeFile(receipt,JSON.stringify(result,null,2));}
 console.log(JSON.stringify(result));
} finally {await fs.rm(directory,{recursive:true,force:true});}
