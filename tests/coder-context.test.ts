import {link,mkdtemp,mkdir,readFile,realpath,rm,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {createManagedHooks} from '../server/context.js';
import {readConfig} from '../server/config.js';
import {createGoal,goalOf} from '../server/goals.js';
import {planOutline,type StoredPlanPhase} from '../server/plan-tasks.js';
import {roleInstructions} from '../server/prompts.js';
import {Runtime,type RuntimeHooks} from '../server/runtime.js';
import {estimateTokens} from '../server/scheduler.js';
import {Store} from '../server/store.js';
import {parseToolArguments,publishedTools} from '../server/tool-registry.js';
import {WorkspaceTools} from '../server/tools/index.js';
import {hash} from '../server/tools/paths.js';
import type {CompletionResult,ModelProvider,ToolResult} from '../shared/types.js';
import {nativeReply} from './native-fixture.js';

type Request = Parameters<ModelProvider['complete']>[0];
type Reply = CompletionResult | ((request: Request) => CompletionResult | Promise<CompletionResult>);
const cleanups: (()=>Promise<void>)[] = [];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse()) await cleanup();});

async function fixture(managed = false, coderLimit = '40000') {
  const temp = await realpath(tmpdir());
  const base = await mkdtemp(path.join(temp,'coder-context-'));
  const root = path.join(base,'project');
  await mkdir(root);
  const db = path.join(base,'state.sqlite');
  const store = new Store(db), tools = new WorkspaceTools();
  const project = store.createProject('Advisory fixture',root), chat = store.createChat(project.id,'Task','review');
  const requests: Request[] = [], replies: Reply[] = [];
  const provider: ModelProvider = {models:async()=>[],complete:async request=>{
    requests.push(request);
    if (request.messages[0].content.startsWith('Write a factual continuation')) {
      return {text:'Historical observations. Continue the original assignment.',finishReason:'stop'};
    }
    const reply = replies.shift();
    if (!reply) throw new Error('Unexpected provider call');
    return typeof reply === 'function' ? reply(request) : reply;
  }};
  const config = readConfig({CODER_INPUT_TOKEN_LIMIT:coderLimit,MODEL_MAX_OUTPUT_TOKENS:'256',TOKENS_PER_MINUTE:'2000000'});
  const hooks:RuntimeHooks = managed ? createManagedHooks(provider,store,config) : {instructions:roleInstructions};
  const boundaries: (()=>void|Promise<void>)[] = [];
  if (hooks.complete) {
    const complete = hooks.complete;
    hooks.complete = (role,request,check) => complete(role,request,check && (async signal=>{
      await boundaries.shift()?.();
      return check(signal);
    }));
  }
  const runtime = new Runtime(store,provider,tools,config,hooks);
  cleanups.push(async()=>{
    await runtime.close();
    await tools.dispose();
    store.close();
    if (path.dirname(base)!==temp || !path.basename(base).startsWith('coder-context-')) throw Error('Unexpected cleanup path');
    await rm(base,{recursive:true,force:true});
  });
  function reference(stepId='step') {
    const {id,version} = store.plan(chat.id);
    return {planId:id!,planVersion:version!,phaseId:'phase',stepId};
  }
  function delegate(paths?: string[], stepId='step') {
    return nativeReply('delegate',{objective:'Implement the bounded source change',acceptanceCriteria:['Check original behavior'],paths,planStep:reference(stepId)});
  }
  return {root,db,store,tools,project,chat,requests,replies,boundaries,runtime,config,reference,delegate,
    put: (filename:string,content:string)=>writeFile(path.join(root,filename),content),
    async run(text='Make the bounded change') {await runtime.submit(chat.id,text);await runtime.wait(chat.id);},
  };
}

const done: CompletionResult = {text:'Fixture complete.',finishReason:'stop'};
const coderDone = nativeReply('submit_completion',{summary:'Fixture coder conclusion.'});
const verdict = nativeReply('review_result',{verdict:'pass',findings:[]});
const shape = (): StoredPlanPhase[] => [{id:'phase',title:'Implement',steps:[{id:'step',title:'Correct behavior',status:'pending'}]}];
const fullRead = (path:string) => nativeReply('read_file',{path});
const callId = (reply:CompletionResult) => reply.toolCalls![0].id;
const cite = (path:string, reply:CompletionResult, symbol?:string) => ({path,callId:callId(reply),symbol});
const ground = (sources: ReturnType<typeof cite>[], newFiles: ReturnType<typeof cite>[] = [], objective='Change only the assigned behavior', stepId='step') => ({
  phaseId:'phase',stepId,sources,newFiles,checks:[{method:'inspection',target:sources[0].path,expected:'Observe the corrected behavior.'}],task:{objective},
});
const setPlan = (entries: ReturnType<typeof ground>[], phases=shape()) => nativeReply('set_plan',{phases,admission:entries});
const packet = (request: Request) => request.messages.find(message=>message.content.startsWith('Advisory Coder context.'));
const toolResult = (request: Request, reply: CompletionResult) => JSON.parse(request.messages.find(message=>message.role==='tool' && message.tool_call_id===callId(reply))!.content) as ToolResult;
const coderRequests = (requests: Request[]) => requests.filter(request=>request.tools?.some(tool=>tool.function.name==='patch_file') && request.messages[0].content.includes('Coder responsibilities'));

it('persists only receipt references and gives the Coder bounded current source, states and observed commands',async()=>{
  const t = await fixture(true);
  await t.put('entry.ts','export function ready() { return "SCOPE_CURRENT"; }\nexport function hidden() { return "OUTSIDE_OBSERVED_SPAN"; }\n');
  await t.put('gone.ts','PREVIOUS_GONE\n');
  await t.put('edited.ts','PREVIOUS_EDIT\n');
  await t.put('unreadable.ts','PREVIOUS_TEXT\n');
  await t.put('other.ts','OTHER_ASSIGNMENT_BODY\n');
  await t.put('package.json','{"scripts":{"test":"never run from advisory data"}}\n');
  const ranged = nativeReply('read_file_range',{path:'entry.ts',startLine:1,count:1});
  const paths = ['gone.ts','edited.ts','unreadable.ts','other.ts','package.json'];
  const reads = paths.map(fullRead);
  const absent = nativeReply('inspect_new_plan_path',{path:'new.ts'});
  const proposal = setPlan([ground([cite('entry.ts',ranged,'ready'),...paths.map((path,index)=>cite(path,reads[index]))],[cite('new.ts',absent)])]);
  t.replies.push(ranged,...reads,absent,proposal,async request=>{
    expect(toolResult(request,proposal)).toMatchObject({ok:true,data:{version:1}});
    await unlink(path.join(t.root,'gone.ts'));
    await t.put('edited.ts','NEW_CHANGED_BODY\n');
    await t.put('unreadable.ts','UNVALIDATED_BINARY\0');
    return t.delegate(['entry.ts','gone.ts','edited.ts','unreadable.ts','package.json','new.ts']);
  },fullRead('other.ts'),coderDone,verdict,done);
  await t.run();
  const requests = coderRequests(t.requests);
  expect(requests).toHaveLength(2);
  const first = packet(requests[0])!.content;
  expect(first).toContain('SCOPE_CURRENT');
  expect(first).not.toMatch(/OUTSIDE_OBSERVED_SPAN|OTHER_ASSIGNMENT_BODY|PREVIOUS_EDIT|NEW_CHANGED_BODY|UNVALIDATED_BINARY/);
  expect(first).toMatch(/"path":"gone.ts","state":"missing"/);
  expect(first).toMatch(/"path":"edited.ts","state":"stale"/);
  expect(first).toMatch(/"path":"unreadable.ts","state":"unreadable"/);
  expect(first).toMatch(/"path":"new.ts","state":"planned-new"/);
  expect(first).toContain('npm run test');
  expect(packet(requests[1])?.content).toContain('"sourceObservation":"previous"');
  expect(packet(requests[1])?.content).not.toContain('SCOPE_CURRENT');
  expect(requests[1].messages.some(m=>m.role==='tool'&&m.content.includes('OTHER_ASSIGNMENT_BODY'))).toBe(true);
  expect(estimateTokens([packet(requests[0])!])-estimateTokens([])).toBeLessThanOrEqual(2048);
  const step = t.store.plan(t.chat.id).phases[0].steps[0];
  expect(step.task?.sources[0]).toMatchObject({hash:expect.stringMatching(/^[a-f0-9]{64}$/),callId:callId(ranged),startLine:1,lineCount:1});
  expect(JSON.stringify(step.task)).not.toMatch(/SCOPE_CURRENT|OUTSIDE_OBSERVED_SPAN/);
  const detail = t.store.detail(t.chat.id);
  const publicTask = JSON.stringify(detail.plan.phases[0].steps[0].task);
  expect(publicTask).toContain('"symbol":"ready"');
  expect(publicTask).not.toMatch(/"callId"|"frameId"|"hash"/);
  expect(detail.events.filter(e=>e.type==='plan').map(e=>JSON.stringify(e.data)).join('\n')).not.toMatch(/"callId"|"frameId"|"hash"|SCOPE_CURRENT/);
  const coderId = (detail.events.find(e=>e.type==='delegation')!.data as {delegationId:string}).delegationId;
  expect(JSON.stringify(t.store.getState('native:frame:'+t.chat.id+':'+coderId,[]))).not.toContain('SCOPE_CURRENT');
  const reopened = new Store(t.db);
  try {expect(reopened.plan(t.chat.id)).toEqual(t.store.plan(t.chat.id));}
  finally {reopened.close();}
  expect(detail.events.filter(e=>e.type==='context_summary')).toHaveLength(0);
});

it('keeps sequential planned tasks isolated and resolves advisory dependency status',async()=>{
  const t = await fixture(true);
  await t.put('alpha.ts','export function alpha() { return "ALPHA_PACKET"; }\n');
  await t.put('beta.ts','export function beta() { return "BETA_PACKET"; }\n');
  const a=fullRead('alpha.ts'), b=fullRead('beta.ts');
  const phases=shape();
  phases[0].steps.push({id:'second',title:'Second task',status:'pending'});
  const first=ground([cite('alpha.ts',a,'alpha')]);
  const second={...ground([cite('beta.ts',b,'beta')],[],'Second task objective','second'),
    task:{objective:'Second task objective',dependsOn:[{phaseId:'phase',stepId:'step'}]}};
  t.replies.push(a,b,setPlan([first,second],phases),()=>t.delegate(['alpha.ts']),fullRead('alpha.ts'),coderDone,verdict,
    ()=>t.delegate(['beta.ts'],'second'),nativeReply('submit_completion',{summary:'Second task.'}),
    nativeReply('review_result',{verdict:'pass',findings:[]}),done);
  await t.run();
  const coder=coderRequests(t.requests);
  expect(coder).toHaveLength(3);
  expect(packet(coder[0])?.content).toContain('ALPHA_PACKET');
  expect(packet(coder[0])?.content).not.toContain('BETA_PACKET');
  expect(packet(coder[2])?.content).toContain('BETA_PACKET');
  expect(packet(coder[2])?.content).not.toContain('ALPHA_PACKET');
  expect(packet(coder[2])?.content).toContain('"dependsOn":[{"phaseId":"phase","stepId":"step","status":"done"}]');
});

it('omits a file over the advisory read cap even when its admitted range is short',async()=>{
  const t=await fixture(true);
  await t.put('entry.ts','export function ready() { return "OVERSIZED_BODY"; }\n'+'x'.repeat(33000)+'\n');
  const read=nativeReply('read_file_range',{path:'entry.ts',startLine:1,count:1});
  t.replies.push(read,setPlan([ground([cite('entry.ts',read,'ready')])]),()=>t.delegate(['entry.ts']),coderDone,verdict,done);
  await t.run();
  const advisory=packet(coderRequests(t.requests)[0])!.content;
  expect(advisory).toContain('"state":"omitted"');
  expect(advisory).not.toContain('OVERSIZED_BODY');
});

it('uses the pre-dispatch lease and observed stamp for every excerpt, including scheduler waits',async()=>{
  const t = await fixture(true);
  await t.put('entry.ts','export function ready() { return "BEFORE_DISPATCH"; }\n');
  const read = fullRead('entry.ts');
  t.replies.push(read,setPlan([ground([cite('entry.ts',read,'ready')])]),()=>t.delegate(['entry.ts']),coderDone,verdict,done);
  t.boundaries.push(async()=>{
    await t.put('entry.ts','export function ready() { return "AFTER_DISPATCH_EDIT"; }\n');
    t.tools.setDirty(t.root,'entry.ts','fixture-editor',true);
  });
  await t.run();
  const advisory = packet(coderRequests(t.requests)[0])!.content;
  expect(advisory).toMatch(/"path":"entry.ts","state":"omitted"/);
  expect(advisory).not.toMatch(/BEFORE_DISPATCH|AFTER_DISPATCH_EDIT/);
});

it('suppresses an initial packet if the exact plan changes after the managed request was reserved',async()=>{
  const t = await fixture(true);
  await t.put('entry.ts','export function ready() { return "SUPERSEDED_BODY"; }\n');
  const read = fullRead('entry.ts');
  t.replies.push(read,setPlan([ground([cite('entry.ts',read,'ready')])]),()=>t.delegate(['entry.ts']),coderDone,verdict,done);
  t.boundaries.push(()=>{
    const plan = t.store.plan(t.chat.id);
    t.store.setPlan(t.chat.id,{...plan,version:plan.version!+1});
  });
  await t.run();
  expect(packet(coderRequests(t.requests)[0])).toBeUndefined();
});

it('never loads source for root scope or unrelated assignments',async()=>{
  const t = await fixture(true);
  await t.put('entry.ts','export function ready() { return "ROOT_SCOPE_BODY"; }\n');
  const read = fullRead('entry.ts');
  t.replies.push(read,setPlan([ground([cite('entry.ts',read)])]),()=>t.delegate(['./']),coderDone,verdict,done);
  await t.run();
  expect(packet(coderRequests(t.requests)[0])?.content).not.toContain('ROOT_SCOPE_BODY');
  t.replies.push(nativeReply('delegate',{objective:'Ordinary bounded task',acceptanceCriteria:['Check it'],paths:['entry.ts']}),
    nativeReply('submit_completion',{summary:'Ordinary.'}),nativeReply('review_result',{verdict:'pass',findings:[]}),done);
  await t.run('Unrelated objective');
  expect(packet(coderRequests(t.requests).at(-1)!)).toBeUndefined();
});

it('uses a canonical exact replay, refuses old receipts for an edit and retains task fields on an unrelated revision',async()=>{
  const t = await fixture();
  await t.put('entry.ts','export function ready() {}\n');
  const read = fullRead('entry.ts'), entry = ground([cite('entry.ts',read,'ready')]);
  t.replies.push(read,setPlan([entry]),done);
  await t.run('/plan Prepare the task');
  const original = t.store.plan(t.chat.id);
  const human = t.store.messages(t.chat.id).find(message=>message.role==='user')!;
  t.store.transaction(()=>createGoal(t.store,t.chat.id,{objective:'Keep protected work',acceptanceCriteria:['Observe verified work']},human.id));
  const owner = 'original-task-owner';
  t.store.progress(t.chat.id,t.reference(),owner,'in_progress','started','Original work');
  const saved = t.store.plan(t.chat.id), before = goalOf(t.store,t.chat.id)!;

  const replay = setPlan([entry]), falseRefresh = setPlan([{...entry,task:{objective:'Unobserved edit'}}]);
  let replayGeneration: number | undefined;
  t.replies.push(()=>{replayGeneration=goalOf(t.store,t.chat.id)?.generation;return replay;},falseRefresh,request=>{
    expect(toolResult(request,falseRefresh).ok).toBe(false);
    return done;
  });
  await t.run('Retain the existing plan');
  expect(t.store.plan(t.chat.id)).toEqual(saved);
  expect(goalOf(t.store,t.chat.id)?.generation).toBe(replayGeneration);

  const revised = shape();
  revised[0].steps.push({id:'second',title:'New unrelated work',status:'pending'});
  const other = fullRead('entry.ts');
  const otherEntry = ground([cite('entry.ts',other)],[],'Second task','second');
  t.replies.push(other,setPlan([otherEntry],revised),done);
  await t.run('Add only the unrelated second step');
  const expanded = t.store.plan(t.chat.id);
  expect(expanded.version).toBe(saved.version!+1);
  expect(expanded.phases[0].steps[0].task).toEqual(original.phases[0].steps[0].task);
  expect(t.store.planStep(t.chat.id,{...t.reference(),planVersion:saved.version!})).toBeUndefined();
  expect(goalOf(t.store,t.chat.id)?.requiredSteps).toEqual(expect.arrayContaining(before.requiredSteps));

  const refresh = fullRead('entry.ts');
  const update = {...entry,sources:[cite('entry.ts',refresh,'ready')],task:{objective:'Clarify the first task'}};
  t.replies.push(refresh,setPlan([update],revised),done);
  await t.run('Clarify first task without altering its title');
  const metadataRevision = t.store.plan(t.chat.id);
  expect(metadataRevision.version).toBe(3);
  expect(metadataRevision.phases[0].steps[0].task).toMatchObject({admittedAtPlanVersion:3,objective:'Clarify the first task'});
  expect(t.store.plan(t.chat.id).phases[0].steps[1].task).toEqual(expanded.phases[0].steps[1].task);
  const clear = setPlan([],[]);
  t.replies.push(clear,done);
  await t.run('Clear the current plan');
  expect(t.store.plan(t.chat.id)).toMatchObject({version:4,phases:[]});
  expect(goalOf(t.store,t.chat.id)?.requiredSteps).toEqual(expect.arrayContaining(before.requiredSteps));
});

it('refuses an aggregate metadata overrun without revising an existing plan',async()=>{
  const t = await fixture();
  await t.put('entry.ts','export function ready() {}\n');
  const phase = (count:number):StoredPlanPhase[]=>[{id:'phase',title:'Bounded plan',steps:Array.from({length:count},(_,i)=>({id:'step-'+i,title:'Task '+i,status:'pending'}))}];
  const wide = (index:number, read:CompletionResult) => ({
    ...ground([cite('entry.ts',read)],[],'é'.repeat(300),'step-'+index),
    checks:Array.from({length:4}, (_,n)=>({method:'inspection',target:'entry.ts',expected:String(n)+'é'.repeat(299)})),
  });
  const first = fullRead('entry.ts');
  t.replies.push(first,setPlan(Array.from({length:16},(_,i)=>wide(i,first)),phase(16)),done);
  await t.run('/plan Build a bounded plan');
  const before = t.store.plan(t.chat.id);
  expect(before.version).toBe(1);
  const read = fullRead('entry.ts'), proposal = setPlan(Array.from({length:8},(_,i)=>wide(i+16,read)),phase(24));
  t.replies.push(read,proposal,request=>{
    expect(toolResult(request,proposal)).toMatchObject({ok:false,output:expect.stringContaining('64 KiB')});
    return done;
  });
  await t.run('Exceed the aggregate metadata volume');
  expect(t.store.plan(t.chat.id)).toEqual(before);
});

it('pages exact structural rows, including legacy empty phases, and rejects a stale revision',async()=>{
  const t = await fixture();
  const plan = t.store.revisePlan(t.chat.id,{phases:[{id:'legacy-empty',title:'Legacy empty',steps:[]},...shape(),
    {id:'future',title:'Future',steps:Array.from({length:14},(_,i)=>({id:'future-'+i,title:'Long title '+i+' ".'.repeat(400),status:'pending'}))}]});
  const pages: ReturnType<typeof planOutline>[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = planOutline(plan,offset);
    pages.push(page);
    offset = page.nextOffset;
  }
  expect(pages.flatMap(page=>page.rows)).toEqual(plan.phases.flatMap(phase=>[
    {phaseId:phase.id,title:phase.title},...phase.steps.map(step=>({phaseId:phase.id,stepId:step.id,title:step.title,status:step.status})),
  ]));
  const read = nativeReply('read_plan',{planId:plan.id,planVersion:plan.version,offset:pages[1].offset});
  const stale = nativeReply('read_plan',{planId:plan.id,planVersion:plan.version!+1,offset:0});
  t.replies.push(read,stale,request=>{
    expect(toolResult(request,read)).toMatchObject({ok:true,data:pages[1]});
    expect(toolResult(request,stale)).toMatchObject({ok:false,data:{id:plan.id,version:plan.version}});
    return done;
  });
  await t.run('/plan Read the saved plan');
  expect(publishedTools('coder').some(tool=>tool.function.name==='read_plan')).toBe(false);
  expect(t.store.plan(t.chat.id)).toEqual(plan);
});

it('keeps critical metadata outside compaction and leaves packet source out of the summary prompt',async()=>{
  const t = await fixture(true,'48000');
  await t.put('entry.ts','export function ready() { return "INITIAL_BODY_ONLY"; }\n');
  const read = fullRead('entry.ts'), discoveries = [];
  for (let i=0;i<8;i++) {
    const name = 'related-'+i+'.txt';
    await t.put(name,'Fixture observation '+i+' '+ 'x'.repeat(2300)+'\n');
    discoveries.push(fullRead(name));
  }
  t.replies.push(read,setPlan([ground([cite('entry.ts',read,'ready')])]),()=>t.delegate(['entry.ts']),
    ...discoveries,coderDone,verdict,done);
  await t.run();
  const coder = coderRequests(t.requests);
  expect(coder).toHaveLength(9);
  expect(packet(coder[0])?.content).toContain('INITIAL_BODY_ONLY');
  expect(packet(coder.at(-1)!)?.content).toContain('Change only the assigned behavior');
  expect(packet(coder.at(-1)!)?.content).not.toContain('INITIAL_BODY_ONLY');
  const summaries = t.requests.filter(request=>request.messages[0].content.startsWith('Write a factual continuation'));
  expect(summaries.length).toBeGreaterThan(0);
  expect(summaries.flatMap(request=>request.messages).map(message=>message.content).join('\n')).not.toMatch(/INITIAL_BODY_ONLY|Advisory Coder context/);
});

it('retains explicit restart behavior without adopting the prior packet or replaying an approval',async()=>{
  const t = await fixture(true);
  const body = 'export function ready() { return "BEFORE_RESTART"; }\n';
  await t.put('entry.ts',body);
  const read = fullRead('entry.ts');
  const proposal = nativeReply('write_file',{path:'entry.ts',content:'Would change the source.',baseHash:hash(body)});
  t.replies.push(read,setPlan([ground([cite('entry.ts',read,'ready')])]),()=>t.delegate(['entry.ts']),proposal);
  await t.run();
  expect(packet(coderRequests(t.requests)[0])?.content).toContain('BEFORE_RESTART');
  expect(t.store.chat(t.chat.id).status).toBe('awaiting_approval');
  await t.runtime.close();

  const store = new Store(t.db), tools = new WorkspaceTools();
  store.recover();
  const requests:Request[] = [];
  const replies = [coderDone,verdict,done];
  const provider:ModelProvider = {models:async()=>[],complete:async input=>{
    requests.push(input);
    const reply = replies.shift();
    if (!reply) throw new Error('Unexpected recovered request');
    return reply;
  }};
  const recovered = new Runtime(store,provider,tools,t.config,createManagedHooks(provider,store,t.config));
  try {
    expect(store.chat(t.chat.id).status).toBe('interrupted');
    expect(requests).toHaveLength(0);
    await recovered.control(t.chat.id,'resume');
    await recovered.wait(t.chat.id);
    expect(coderRequests(requests)).toHaveLength(1);
    expect(requests.some(request=>packet(request))).toBe(false);
    expect(await readFile(path.join(t.root,'entry.ts'),'utf8')).toBe(body);
  } finally {await recovered.close(); await tools.dispose(); store.close();}
});

it('suppresses a linked source introduced before provider dispatch',async()=>{
  const t = await fixture(true);
  await t.put('other.ts','PRIVATE_LINK_TARGET\n');
  await mkdir(path.join(t.root,'src'));
  const source = 'export function other() {}\n';
  await t.put('src/main.ts',source);
  const scoped = fullRead('src/main.ts');
  t.boundaries.push(async()=>{
    await unlink(path.join(t.root,'src/main.ts'));
    await link(path.join(t.root,'other.ts'),path.join(t.root,'src/main.ts'));
  });
  t.replies.push(scoped,setPlan([ground([cite('src/main.ts',scoped)])]),()=>t.delegate(['src']),async()=>{
    await unlink(path.join(t.root,'src/main.ts'));
    await t.put('src/main.ts',source);
    return coderDone;
  },verdict,done);
  await t.run();
  const advisory = packet(coderRequests(t.requests)[0])!.content;
  expect(advisory).toContain('"state":"unreadable"');
  expect(advisory).not.toContain('PRIVATE_LINK_TARGET');
});

it('preserves the existing capacity refusal at a 16 KiB estimated Coder window',()=>{
  const store = new Store(':memory:');
  const config = readConfig({CODER_INPUT_TOKEN_LIMIT:'16384',MODEL_MAX_OUTPUT_TOKENS:'256'});
  const provider = {models:async()=>[],complete:async()=>{throw new Error('Unexpected provider call');}};
  try {
    const hooks = createManagedHooks(provider,store,config);
    expect(()=>hooks.complete!('coder',{model:'fixture',messages:[{role:'system',content:roleInstructions('coder')}],
      tools:publishedTools('coder'),maxTokens:256})).toThrow(/context capacity/);
  } finally {store.close();}
});

it('strictly parses the advisory task fields without trusting model metadata or execution flags',()=>{
  const shapeWith = (task:unknown) => JSON.stringify({phases:shape(),admission:[{...ground([cite('entry.ts',fullRead('entry.ts'))]),task}]});
  expect(()=>parseToolArguments('set_plan',shapeWith({objective:'é'.repeat(301)}))).toThrow();
  expect(()=>parseToolArguments('set_plan',shapeWith({objective:'Read source',dependsOn:[{phaseId:'p',stepId:'s'},{phaseId:'p',stepId:'s'}]}))).toThrow();
  expect(()=>parseToolArguments('set_plan',shapeWith({objective:'Read source',sources:[],version:1,skipTests:true}))).toThrow();
  expect(()=>parseToolArguments('set_plan',shapeWith({objective:'Read source'}))).not.toThrow();
});
