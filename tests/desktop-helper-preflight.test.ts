import { afterEach,expect,it,vi } from 'vitest';
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { helperPreflight,trustedHelper } from '../desktop/helper-preflight.js';
import { boundedProcess } from '../desktop/process.js';
import { DesktopController } from '../desktop/controller.js';
import { OptionalSystemInstalls } from '../client/OptionalSystemInstalls.js';
vi.mock('node:child_process',async original=>({...await original<typeof import('node:child_process')>(),spawn:vi.fn()}));
vi.mock('../desktop/process.js',async original=>({...await original<typeof import('../desktop/process.js')>(),boundedProcess:vi.fn()}));
vi.mock('node:fs/promises',async original=>({...await original<typeof import('node:fs/promises')>(),lstat:vi.fn()}));
afterEach(()=>vi.clearAllMocks());
const blocked=()=>helperPreflight({trusted:async()=>{throw new Error('missing');},system:async()=>{throw new Error('must not get here');}});
const metadata=(name:string)=>({uid:0,mode:0o755,isSymbolicLink:()=>false,isFile:()=>name.endsWith('/launcher')||name.endsWith('/pkexec'),isDirectory:()=>!name.endsWith('/launcher')&&!name.endsWith('/pkexec')&&!name.endsWith('system_bus_socket'),isSocket:()=>name.endsWith('system_bus_socket')});
it.each(['launcher directory','pkexec non-executable','systemd file','bus file'] as const)('rejects unusable staged path: %s',async fault=>{
  vi.mocked(lstat).mockImplementation(async name=>{
    const p=String(name),s=metadata(p);
    if(fault==='launcher directory'&&p.endsWith('/launcher'))s.isFile=()=>false;
    if(fault==='pkexec non-executable'&&p.endsWith('/pkexec'))s.mode=0o644;
    if(fault==='systemd file'&&p==='/run/systemd/system')s.isDirectory=()=>false;
    if(fault==='bus file'&&p.endsWith('system_bus_socket'))s.isSocket=()=>false;
    return s as Awaited<ReturnType<typeof lstat>>;
  });
  if(fault.startsWith('launcher')||fault.startsWith('pkexec'))await expect(trustedHelper()).rejects.toThrow();
  const result=await helperPreflight();expect(result.setup.canStart).toBe(false);expect(result.repair.canStart).toBe(false);
});
it('explains missing/untrusted launcher and pkexec without attempting service or authentication operations',async()=>{
  const system=vi.fn();const result=await helperPreflight({trusted:async()=>{throw new Error('missing or unsafe');},system});
  expect(system).not.toHaveBeenCalled();expect(result.setup.canStart).toBe(false);expect(result.setup.message).toContain('stage the abysSUS helper');expect(result.setup.message).toContain('OS authentication');
});
it('blocks missing system services but does not depend on client descriptors, helper hello or agent process names',async()=>{
  const trusted=vi.fn(async()=>{});
  const missing=await helperPreflight({trusted,system:async()=>{throw new Error();}});expect(missing.repair.canStart).toBe(false);expect(missing.uninstall.message).toContain('systemd');
  const staged=await helperPreflight({trusted,system:async()=>{}});
  expect(staged.repair.canStart).toBe(true);expect(staged.uninstall.canStart).toBe(true);expect(staged.setup.message).toContain('authorization are not verified');
});
it.each(['setup','repair','uninstall'] as const)('unavailable %s leaves exact working ownership, identity and session intact with no action dispatch',async action=>{
  const controller=new DesktopController('/unused'),child={},identity={},target={address:'http://127.0.0.1:1234',token:'private-test',sessionId:'original'};
  const internal=controller as unknown as {child:unknown;identity:unknown;key:string;active:unknown;command:(...args:unknown[])=>unknown};
  internal.child=child;internal.identity=identity;internal.key='private-test';internal.active=target;
  internal.command=vi.fn(()=>({file:'/fixed/runtime/node',args:['/fixed/helper-entry.js','preflight'],cwd:'/fixed'}));
  controller.state={platform:'linux',phase:'ready',sessionId:'original',selection:{environment:{kind:'linux'},home:'/profile'},distributions:[],message:'Connected'};
  const checks=await blocked();vi.mocked(boundedProcess).mockResolvedValue(JSON.stringify(checks));const stop=vi.spyOn(controller,'stop');
  const result=await controller.helper(action);
  expect(result.phase).toBe('ready');expect(result.sessionId).toBe('original');expect(result.helperReadiness).toEqual(checks);
  expect(controller.target()).toBe(target);expect(internal.child).toBe(child);expect(internal.identity).toBe(identity);expect(internal.key).toBe('private-test');
  expect(stop).not.toHaveBeenCalled();expect(spawn).not.toHaveBeenCalled();expect(internal.command).toHaveBeenCalledExactlyOnceWith({kind:'linux'},'helper-entry.js',['preflight']);
  expect(boundedProcess).toHaveBeenCalledTimes(1);
});
it('renders disabled unavailable operations, separate provider guidance and an enabled way to continue',async()=>{
  const markup=renderToStaticMarkup(createElement(OptionalSystemInstalls,{status:{platform:'linux',phase:'ready',distributions:[],message:'Connected',helperReadiness:await blocked()},busy:false,run:()=>{},continueToChats:()=>{}}));
  expect(markup.match(/disabled=""/g)).toHaveLength(3);expect(markup).toContain('separate from the model provider endpoint');expect(markup).toContain('stage the abysSUS helper');expect(markup).toContain('OS authentication');
  expect(markup).toContain('<button class="button primary">Continue to chats</button>');
});
it('does not relabel a backend that exits during awaited preflight as connected',async()=>{
  const controller=new DesktopController('/unused'),internal=controller as unknown as {child:unknown;command:()=>unknown};
  internal.child={};internal.command=()=>({file:'fixed',args:['preflight'],cwd:'.'});
  controller.state={platform:'linux',phase:'ready',sessionId:'old',selection:{environment:{kind:'linux'},home:'/profile'},distributions:[],message:'Connected'};
  let finish!:(value:string)=>void;vi.mocked(boundedProcess).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const stop=vi.spyOn(controller,'stop'),operation=controller.helper('setup');
  controller.state.phase='failed';controller.state.message='Backend exited';internal.child=undefined;finish(JSON.stringify(await blocked()));
  await expect(operation).rejects.toThrow('Backend changed');expect(controller.state.message).toBe('Backend exited');expect(controller.target()).toBeUndefined();expect(stop).not.toHaveBeenCalled();expect(spawn).not.toHaveBeenCalled();
});
