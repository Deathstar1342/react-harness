import {afterEach,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {installResolutions} from '../server/goals.js';
import type {Goal} from '../shared/types.js';
import {Store} from '../server/store.js';
import {InstallService} from '../server/installs.js';
import {helperCanonical,helperProtocol} from '../server/package-helper.js';
import type {ContainerPackageTarget,PackageHelperTarget} from '../shared/types.js';
import {fakeHelper} from './install-fixture.js';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0))await fn();});
function fixture(){
  const store=new Store(':memory:'),a=store.createProject('A','/workspace/a'),b=store.createProject('B','/workspace/b');
  const chatA=store.createChat(a.id,'A','autonomous'),chatB=store.createChat(b.id,'B','autonomous');
  const target=(id:string):ContainerPackageTarget=>({scope:'project-container',id:createHash('sha256').update(id).digest('hex'),storageId:randomUUID(),projectId:createHash('sha256').update(id+'project').digest('hex'),baseImageId:'sha256:'+'a'.repeat(64),generation:randomUUID(),distribution:'debian',release:'12',architecture:'amd64',manager:'apt',adapterVersion:1});
  const targets=new Map([[a.id,target(a.id)],[b.id,target(b.id)]]),helpers=new Map([[a.id,fakeHelper()],[b.id,fakeHelper()]]);
  for(const [id,f] of helpers){
    const prepare=f.helper.prepare.getMockImplementation()!,execute=f.helper.execute.getMockImplementation()!;
    f.helper.prepare.mockImplementation(async request=>{const record=await prepare(request);record.preview.target=structuredClone(targets.get(id)!);record.previewDigest=createHash('sha256').update(helperCanonical(record.preview)).digest('hex');f.records.set(request.requestId,structuredClone(record));return record;});
    f.helper.execute.mockImplementation(async decision=>{const record=await execute(decision),original=record.preview.target as ContainerPackageTarget;record.containerReceipt={targetId:original.id,baseImageId:original.baseImageId,imageId:'sha256:'+'b'.repeat(64),generation:randomUUID(),manifestDigest:'c'.repeat(64)};f.records.set(decision.requestId,structuredClone(record));return record;});
  }
  const connect=vi.fn(async(id:string,original?:PackageHelperTarget)=>{
    const f=helpers.get(id)!;
    if(original&&!Array.from(f.records.values()).some(r=>helperCanonical(r.preview.target)===helperCanonical(original)))throw new Error('original unavailable');
    return {...f.helper,hello:async()=>({protocol:helperProtocol,target:structuredClone(original??targets.get(id)!)})};
  });
  const complete=vi.fn(async()=>({text:'',finishReason:'stop'}));
  const service=new InstallService(store,'critic',complete,undefined,Date.now,20000,{connect,available:async()=>true});
  cleanup.push(async()=>{await service.close();store.close();});
  const create=(chatId:string)=>service.create(randomUUID(),chatId,'frame','architect',0,{packages:[{name:'hello'}],reason:'Run project greeting test'});
  const advance=(id:string)=>service.advance(id,()=>true,new AbortController().signal);
  return {store,a,b,chatA,chatB,targets,helpers,connect,service,create,advance};
}
it('keeps B pending when A publishes a different image, without resetting profile policy/revision',async()=>{
  const f=fixture(),b=f.create(f.chatB.id),a=f.create(f.chatA.id);
  await f.advance(b.id);await f.advance(a.id);const revision=f.service.settings().revision;
  f.service.decide(a.id,'approve',()=>true);expect(await f.advance(a.id)).toMatchObject({ok:true});
  f.targets.set(f.a.id,{...f.targets.get(f.a.id)!,id:'d'.repeat(64),generation:randomUUID(),baseImageId:'sha256:'+'e'.repeat(64)});
  expect(f.store.install(b.id).state).toBe('pending');expect(f.service.settings()).toMatchObject({policy:'ask',revision});expect(f.service.settings().target).toBeUndefined();
  f.service.decide(b.id,'approve',()=>true);expect(await f.advance(b.id)).toMatchObject({ok:true});
  expect(f.store.install(a.id).containerReceipt?.targetId).not.toBe(f.targets.get(f.a.id)!.id);
});
it('recovery resolves the original immutable target after the project latest generation changes',async()=>{
  const f=fixture(),a=f.create(f.chatA.id);await f.advance(a.id);f.service.decide(a.id,'approve',()=>true);await f.advance(a.id);
  const original=f.store.install(a.id).settings.target!;
  f.targets.set(f.a.id,{...f.targets.get(f.a.id)!,id:'d'.repeat(64),generation:randomUUID()});
  expect(await f.service.recover(a.id,false)).toMatchObject({state:'succeeded',recoveryRequired:false});
  expect(f.connect).toHaveBeenLastCalledWith(f.a.id,original);expect(f.helpers.get(f.a.id)!.helper.execute).toHaveBeenCalledTimes(1);
});
it('global install policy revision invalidates both projects without transferring approval',async()=>{
  const f=fixture(),a=f.create(f.chatA.id),b=f.create(f.chatB.id);await f.advance(a.id);await f.advance(b.id);
  f.service.update({revision:f.service.settings().revision,policy:'auto'});
  expect(f.store.install(a.id).state).toBe('stale');expect(f.store.install(b.id).state).toBe('stale');
  expect(f.helpers.get(f.a.id)!.helper.execute).not.toHaveBeenCalled();expect(f.helpers.get(f.b.id)!.helper.execute).not.toHaveBeenCalled();
});
it('a changed A generation rejects its old approval before execute',async()=>{
  const f=fixture(),a=f.create(f.chatA.id);await f.advance(a.id);f.service.decide(a.id,'approve',()=>true);
  f.targets.set(f.a.id,{...f.targets.get(f.a.id)!,id:'d'.repeat(64),generation:randomUUID()});
  expect(await f.advance(a.id)).toMatchObject({ok:false});expect(f.helpers.get(f.a.id)!.helper.execute).not.toHaveBeenCalled();
});

it.each(['imageId','generation','manifestDigest'] as const)('rejects replacement final container %s during recovery',async field=>{
  const f=fixture(),a=f.create(f.chatA.id);await f.advance(a.id);f.service.decide(a.id,'approve',()=>true);await f.advance(a.id);
  const before=structuredClone(f.store.install(a.id)),records=f.helpers.get(f.a.id)!.records,record=records.get(a.id)!;
  record.containerReceipt![field]=field==='generation'?randomUUID():field==='imageId'?'sha256:'+'d'.repeat(64):'d'.repeat(64);
  await expect(f.service.recover(a.id,false)).rejects.toThrow(/original recovery gate/);
  expect(f.store.install(a.id)).toEqual(before);
  expect(f.helpers.get(f.a.id)!.helper.execute).toHaveBeenCalledTimes(1);
});

it('resolves container goal uncertainty from original target and retained final image lineage without a global target',async()=>{
  const f=fixture(),a=f.create(f.chatA.id);await f.advance(a.id);f.service.decide(a.id,'approve',()=>true);await f.advance(a.id);
  const item=f.store.install(a.id),event=f.store.event(f.chatA.id,'goal_uncertainty',{installId:a.id});
  f.store.setState(`goal-install-links:${f.chatA.id}`,[{eventId:event.id,installId:a.id,targetKey:helperCanonical(item.settings.target),previewDigest:item.previewDigest}]);
  const goal={uncertainEventIds:[event.id]} as Goal;
  expect(installResolutions(f.store,f.chatA.id,goal)).toEqual([]);
  await f.service.recover(a.id,false);
  expect(f.service.settings().target).toBeUndefined();expect(installResolutions(f.store,f.chatA.id,goal)).toHaveLength(1);
  const changed=f.store.install(a.id);changed.containerReceipt!.imageId='sha256:'+'f'.repeat(64);f.store.saveInstall(changed);
  expect(installResolutions(f.store,f.chatA.id,goal)).toEqual([]);
});
