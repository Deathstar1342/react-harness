import { createHash, randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { Store } from '../server/store.js';
import { InstallService, type InstallHelper } from '../server/installs.js';
import { helperCanonical, helperProtocol } from '../server/package-helper.js';
import type { PackageHelperRecord, PackageHelperTarget } from '../shared/types.js';

export const target:PackageHelperTarget={id:'a'.repeat(64),installationId:randomUUID(),machineId:'b'.repeat(32),distribution:'ubuntu',release:'24.04',architecture:'amd64',manager:'apt',adapterVersion:1};
export function fakeHelper(now:()=>number=Date.now) {
  const records=new Map<string,PackageHelperRecord>();
  const helper = {
    hello:vi.fn(async()=>({protocol:helperProtocol,target:structuredClone(target)})),
    prepare:vi.fn<InstallHelper['prepare']>(async request=>{
      const packages=request.packages.map(p=>({name:p.name,version:p.version??'1.0',architecture:'amd64',sha256:'c'.repeat(64),downloadBytes:100,installedBytes:200,requested:true,uris:[`https://archive.ubuntu.com/${p.name}.deb`],repositories:[{origin:'Ubuntu',label:'Ubuntu',archive:'noble',component:'main',site:'archive.ubuntu.com',trusted:true}]}));
      const preview:PackageHelperRecord['preview']={target:structuredClone(target),packages,stateDigest:'d'.repeat(64),repositoryDigest:'e'.repeat(64),impact:{newPackages:packages.length,downloadBytes:packages.length*100,installedBytes:packages.length*200,removals:0,upgrades:0,downgrades:0,maintainerScripts:'trusted-package-root-execution',triggers:'may-modify-existing-packages-and-services',serviceChanges:'package-defined'}};
      const record:PackageHelperRecord={requestId:request.requestId,request,preview,previewDigest:createHash('sha256').update(helperCanonical(preview)).digest('hex'),state:'prepared',createdAt:now(),updatedAt:now(),expiresAt:now()+120000,code:'PREPARED'};
      records.set(request.requestId,record);return structuredClone(record);
    }),
    authorize:vi.fn<InstallHelper['authorize']>(async decision=>{const record=records.get(decision.requestId)!;Object.assign(record,{state:'authorized',decision,code:'AUTHORIZED'});return structuredClone(record);}),
    execute:vi.fn<InstallHelper['execute']>(async decision=>{const record=records.get(decision.requestId)!;Object.assign(record,{state:'succeeded',code:'INSTALLED',reconciliation:{matches:true,healthy:true,packages:record.preview.packages.map(p=>({name:p.name,expectedVersion:p.version,installedVersion:p.version}))}});return structuredClone(record);}),
    status:vi.fn<InstallHelper['status']>(async id=>structuredClone(records.get(id)!)),
    reconcile:vi.fn<InstallHelper['reconcile']>(async id=>{const record=records.get(id)!;record.reconciliation={matches:false,healthy:true,packages:[]};return structuredClone(record);}),
  } satisfies InstallHelper;
  return {helper,records};
}
export function installFixture(options:{now?:()=>number;review?:string;timeout?:number;store?:Store}={}) {
  const store=options.store??new Store(':memory:');
  const project=store.createProject('Test','/workspace'),chat=store.createChat(project.id,'Install','autonomous');
  const {helper,records}=fakeHelper(options.now);
  const complete=vi.fn(async()=>({text:options.review??'{"decision":"approve","reason":"A specific dependency"}',finishReason:'stop'}));
  const service=new InstallService(store,'initial-critic',complete,async()=>helper,options.now,options.timeout);
  const create=(reason='Required compiler')=>service.create(randomUUID(),chat.id,'frame','architect',0,{packages:[{name:'hello'}],reason});
  const advance=(id:string,signal=new AbortController().signal,guard=()=>true)=>service.advance(id,guard,signal);
  return {store,project,chat,helper,records,complete,service,create,advance};
}
export function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
