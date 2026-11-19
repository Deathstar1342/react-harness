import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceTools } from '../server/tools/index.js';
import { definitionFor } from '../server/tool-registry.js';
import { reviewWorkspaceCommand } from '../server/command-review.js';
import type { RuntimeHooks } from '../server/runtime.js';

const cleanups: Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});

it('runs ordinary rooted commands and refuses escaping operands or cwd in every approval mode',async()=>{
  const parent=await mkdtemp(path.join(tmpdir(),'local-command-'));
  cleanups.push(()=>rm(parent,{recursive:true,force:true}));
  const root=path.join(parent,'project'),home=path.join(parent,'app');
  await mkdir(root);await mkdir(home);
  const tools=new WorkspaceTools();
  cleanups.push(()=>tools.dispose());
  tools.configureWorkspace({home,protectedPaths:[],projects:()=>[root]});
  const context={projectRoot:root,chatId:'test',agentId:'test'};
  const run=(command:string,cwd?:string)=>tools.execute(context,{name:'run_shell',args:{command,...(cwd?{cwd}:{})}});
  await expect(run('mkdir "child dir"')).resolves.toMatchObject({ok:true});
  const inspect=definitionFor('start_process').inspect;
  const dispatcher={workspace:tools,context,control:async()=>{throw new Error('Unused');}};
  await expect(inspect(dispatcher,{name:'start_process',args:{command:'ls',cwd:'child dir'}})).resolves.toMatchObject({commandCwd:path.join(root,'child dir')});
  await expect(inspect(dispatcher,{name:'start_process',args:{command:'rm ../*'}})).rejects.toThrow(/traversal/);
  await expect(run('ls')).resolves.toMatchObject({ok:true,output:expect.stringContaining('child dir')});
  await expect(run('pwd','child dir')).resolves.toMatchObject({ok:true,output:expect.stringContaining(path.join(root,'child dir'))});
  await expect(run('node -e "process.stdout.write(process.cwd())"','child dir')).resolves.toMatchObject({ok:true,output:path.join(root,'child dir')});
  for(const command of ['rm ../*','mkdir ../escape','rm -r ..','mkdir ok; rm ../*','ls /','mkdir .env']) {
    await expect(run(command)).resolves.toMatchObject({ok:false});
  }
  await expect(run('mkdir escape','..')).resolves.toMatchObject({ok:false});
  await expect(stat(path.join(parent,'escape'))).rejects.toMatchObject({code:'ENOENT'});
  await expect(run('rm -r "child dir"')).resolves.toMatchObject({ok:true});
  await expect(readFile(path.join(root,'child dir','dummy'))).rejects.toMatchObject({code:'ENOENT'});
});

it('passes the exact command, root, and pwd to an independent reviewer and requires a strict decision',async()=>{
  const result=vi.fn<NonNullable<RuntimeHooks['complete']>>().mockResolvedValue({text:'{"decision":"reject","reason":"Outside workspace"}',finishReason:'stop',toolCalls:[]});
  const action={name:'run_shell',args:{command:'rm ../*'}};
  expect(await reviewWorkspaceCommand(result,'fixture-critic','/project','/project/child',action,new AbortController().signal)).toBe('reject');
  const [,request]=result.mock.calls[0];
  expect(request.tools).toBeUndefined();
  expect(request.messages[0].content).toContain('outside workspaceRoot');
  expect(JSON.parse(String(request.messages[1].content))).toEqual({workspaceRoot:'/project',pwd:'/project/child',action});
  result.mockResolvedValue({text:'{"decision":"reject","decision":"approve","reason":"invalid"}',finishReason:'stop',toolCalls:[]});
  expect(await reviewWorkspaceCommand(result,'fixture-critic','/project','/project',action,new AbortController().signal)).toBe('ask');
});
