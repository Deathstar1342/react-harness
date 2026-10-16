import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
const mocks=vi.hoisted(()=>({spawn:vi.fn(),read:vi.fn(),engine:vi.fn(),readiness:vi.fn(),proof:vi.fn()}));
vi.mock('node:child_process',()=>({spawn:mocks.spawn}));
vi.mock('node:fs',()=>({readFileSync:mocks.read}));
vi.mock('../desktop/support-runtime.js',()=>({supportRuntime:()=>'/private/python'}));
vi.mock('../desktop/container-engine.js',()=>({detectContainerEngine:mocks.engine,engineQuery:()=>{},sameEngine:()=>{}}));
vi.mock('../desktop/readiness.js',()=>({waitForReadiness:mocks.readiness}));
vi.mock('../server/lifecycle.js',()=>({signBackendRequest:()=>({}),verifyBackendProof:mocks.proof}));
import { ContainerDesktopController } from '../desktop/container-controller.js';
function fakeChild(){return Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),exitCode:null as number|null,kill:vi.fn()});}
let children:ReturnType<typeof fakeChild>[]=[];
beforeEach(()=>{
  mocks.read.mockReturnValue(JSON.stringify({version:1,source:'1'.repeat(40),controllerImage:'sha256:'+'2'.repeat(64),workerImage:'sha256:'+'3'.repeat(64)}));
  mocks.engine.mockResolvedValue({context:'default',id:'engine',dataRoot:'/var/lib/docker'});mocks.readiness.mockResolvedValue(undefined);mocks.proof.mockReturnValue(true);
  mocks.spawn.mockImplementation(()=>{const child=fakeChild();children.push(child);return child;});
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({})})));
});
afterEach(()=>{for(const child of children){child.exitCode=1;child.emit('close',1);}children=[];vi.unstubAllGlobals();vi.clearAllMocks();});
const selection={path:'/selected/storage',storageId:randomUUID()};
const ready={address:'http://127.0.0.1:30123',identity:{protocol:'abyssus-backend-v1',instanceId:randomUUID(),profileId:randomUUID(),pid:234,platform:'linux',state:'ready'},checks:[],reconnect:false,key:'a'.repeat(64),token:'b'.repeat(64)};
async function opening(){const controller=new ContainerDesktopController('/app');await controller.inventory();const opening=controller.start(selection,'existing');await vi.waitFor(()=>expect(children).toHaveLength(1));return {controller,opening,child:children[0]!};}
async function connected(){const t=await opening();t.child.stdout.write(JSON.stringify({ready})+'\n');await t.opening;return t;}
it('a malformed frame following ready in the same chunk permanently vetoes activation',async()=>{
  const t=await opening();const rejected=expect(t.opening).rejects.toThrow();t.child.stdout.write(JSON.stringify({ready})+'\n{}\n');await rejected;expect(t.controller.target()).toBeUndefined();expect(t.controller.state.phase).toBe('failed');
});
it.each(['{}\n','x'.repeat(262145),JSON.stringify({id:1,result:{},unexpected:true})+'\n'])('invalid post-ready transport revokes target and denies further writes',async raw=>{
  const t=await connected();const pending=t.controller.authorizeTransfer('c'.repeat(64));const rejected=expect(pending).rejects.toThrow(/uncertain/);t.child.stdout.write(raw);await rejected;
  const bytes=t.child.stdin.readableLength;t.child.stdout.write(JSON.stringify({id:1,result:{code:'d'.repeat(64)}})+'\n');
  await expect(t.controller.authorizeTransfer('c'.repeat(64))).rejects.toThrow(/unavailable/);expect(t.child.stdin.readableLength).toBe(bytes);expect(t.controller.target()).toBeUndefined();expect(t.child.kill).not.toHaveBeenCalled();
});
it('clean drain waits for exact supervisor exit before allowing immediate restart',async()=>{
  const t=await connected();t.child.stdin.on('data',(data:Buffer)=>{const frame=JSON.parse(data.toString());if(frame.id)t.child.stdout.write(JSON.stringify({id:frame.id,result:{stopped:true}})+'\n');});
  let done=false;const stopping=t.controller.stop().then(()=>{done=true;});await vi.waitFor(()=>expect(t.child.stdin.writableEnded).toBe(true));expect(done).toBe(false);expect(t.controller.state.phase).toBe('stopping');
  t.child.exitCode=0;t.child.emit('close',0);await stopping;expect(t.controller.state.phase).toBe('setup');
  const reopening=t.controller.start(selection,'existing');await vi.waitFor(()=>expect(children).toHaveLength(2));children[1]!.stdout.write(JSON.stringify({ready})+'\n');await reopening;expect(t.controller.target()).toBeDefined();
});
it('a nonzero supervisor exit after drain remains failed',async()=>{
  const t=await connected();t.child.stdin.on('data',(data:Buffer)=>{const frame=JSON.parse(data.toString());if(frame.id)t.child.stdout.write(JSON.stringify({id:frame.id,result:{stopped:true}})+'\n');});
  const stopping=t.controller.stop(),rejected=expect(stopping).rejects.toThrow(/exit remains unverified/);await vi.waitFor(()=>expect(t.child.stdin.writableEnded).toBe(true));t.child.exitCode=1;t.child.emit('close',1);await rejected;expect(t.controller.state.phase).toBe('failed');expect(t.controller.target()).toBeUndefined();
});
