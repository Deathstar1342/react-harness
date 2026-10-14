// Run ONLY in the disposable Linux CI step with user namespaces disabled.
// No production environment switch or fallback is used.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceTools } from '../server/tools/index.js';

assert.equal(process.platform,'linux');assert.notEqual(process.getuid!(),0);
const base=await mkdtemp(path.join(tmpdir(),'sandbox-unsupported-')),root=path.join(base,'project');await mkdir(root);
const tools=new WorkspaceTools();tools.configureSandbox({home:path.join(base,'app'),protectedPaths:[],projects:()=>[]});
try {
  const result=await tools.execute({projectRoot:root,chatId:'unsupported',agentId:'coder'},{name:'run_shell',args:{command:'touch must-not-run'}});
  assert.equal(result.ok,false);assert.equal((result.data as {code:string}).code,'SANDBOX_UNAVAILABLE');
  await assert.rejects(access(path.join(root,'must-not-run')));
  console.log('PASS: disabled user namespaces fail closed before agent code executes');
}finally{await tools.dispose();await rm(base,{recursive:true,force:true});}
