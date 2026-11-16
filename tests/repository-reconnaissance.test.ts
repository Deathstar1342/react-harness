import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { nativeReply } from './native-fixture.js';
import { readConfig } from '../server/config.js';
import { goalOf } from '../server/goals.js';
import { roleInstructions } from '../server/prompts.js';
import { repositoryOverview, reconnaissanceLimits, reconnaissanceRoot } from '../server/repository-reconnaissance.js';
import { Runtime } from '../server/runtime.js';
import { estimateTokens } from '../server/scheduler.js';
import { Store } from '../server/store.js';
import type { StoredPlanPhase } from '../server/plan-tasks.js';
import { WorkspaceTools } from '../server/tools/index.js';
import type { CompletionResult, ModelProvider, ToolResult } from '../shared/types.js';

type Request = Parameters<ModelProvider['complete']>[0];
type Reply = CompletionResult | ((request: Request) => CompletionResult | Promise<CompletionResult>);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const temp = await realpath(tmpdir());
  const base = await mkdtemp(path.join(temp, 'planning-recon-'));
  const root = path.join(base, 'project');
  await mkdir(root);
  const filename = path.join(base, 'state.sqlite');
  const store = new Store(filename);
  const tools = new WorkspaceTools();
  const project = store.createProject('Planning fixture', root);
  const chat = store.createChat(project.id, 'Planning', 'review');
  const requests: Request[] = [], replies: Reply[] = [];
  const provider: ModelProvider = { models: async () => [], complete: async input => {
    requests.push(input);
    const reply = replies.shift();
    if (!reply) throw new Error('Unexpected fixture model call');
    return typeof reply === 'function' ? reply(input) : reply;
  }};
  const runtime = new Runtime(store, provider, tools, readConfig({}), {instructions:roleInstructions});
  cleanups.push(async () => {
    await runtime.close();
    store.close();
    if (path.dirname(base) !== temp || !path.basename(base).startsWith('planning-recon-')) {
      throw new Error('Unexpected fixture cleanup route');
    }
    await rm(base, {recursive: true, force: true});
  });
  return {base, root, store, tools, project, chat, requests, replies, filename, runtime,
    put: (name: string, content: string) => writeFile(path.join(root, name), content),
    run: async (text = '/plan Plan the requested correction', chatId = chat.id) => {
      await runtime.submit(chatId, text);
      await runtime.wait(chatId);
    },
  };
}

const done: Reply = {text:'Planning reply.', finishReason:'stop'};
const read = (filename = 'app.ts') => nativeReply('read_file', {path:filename});
const range = (startLine: number, count = 1) => nativeReply('read_file_range', {path:'app.ts',startLine,count});
const id = (reply: CompletionResult) => reply.toolCalls![0].id;
const phases: StoredPlanPhase[] = [{id:'p', title:'Correction', steps:[{id:'s',title:'Update greeting',status:'done'}]}];
const check = (target: string) => ({method:'inspection',target,expected:'Confirm the greeting uses the requested wording.'});
const evidence = (reply: CompletionResult, filename = 'app.ts', extra: object = {}) => ({phaseId:'p',stepId:'s',
  sources:[{path:filename,callId:id(reply),...extra}],newFiles:[],checks:[check(filename)]});
const plan = (admission: object[] = [], structure = phases) => nativeReply('set_plan', {phases:structure,admission});
const overview = (request: Request) => request.messages.find(message => message.content.startsWith('Repository overview'));
const resultOf = (request: Request, reply: CompletionResult): ToolResult & {truncated?: boolean} =>
  JSON.parse(request.messages.find(message => message.role === 'tool' && message.tool_call_id === id(reply))!.content);
const source = 'export function greet() { return "Hello"; }\nexport function hidden() { return "World"; }\n';

it('projects sorted project observations, omits protected content and respects the managed token budget', async () => {
  const t = await fixture();
  await t.put('package.json', '{"scripts":{"test":"NEVER_DISCLOSE_COMMAND"},"dependencies":{"react":"1"},"main":"app.ts"}');
  await t.put('app.ts', 'import { thing } from "./local";\n' + source);
  await t.put('.env', 'NEVER_DISCLOSE_ENV');
  await t.put('private.sqlite3', 'NEVER_DISCLOSE_DATABASE');
  await mkdir(path.join(t.root, 'node_modules'));
  await t.put('node_modules/private.ts', 'NEVER_DISCLOSE_DEPENDENCIES');
  await writeFile(path.join(t.base, 'outside.ts'), 'NEVER_DISCLOSE_LINK');
  await link(path.join(t.base, 'outside.ts'), path.join(t.root, 'linked.ts'));
  const root = reconnaissanceRoot(t.root), signal = new AbortController().signal;
  const first = await repositoryOverview(root, signal);
  expect(await repositoryOverview(root, signal)).toEqual(first);
  expect(first.role).toBe('user');
  expect(first.content).toContain('"app.ts"');
  expect(first.content).toContain('greet');
  expect(first.content).toContain('script names (sample): test');
  expect(first.content).toContain('package.json dependencies (sample): react');
  expect(first.content).toContain('./local');
  expect(first.content).not.toMatch(/NEVER_DISCLOSE|private\.sqlite3|linked\.ts|\.env|node_modules/);
  expect(estimateTokens([first])).toBeLessThanOrEqual(reconnaissanceLimits.overviewTokens);
  await Promise.all(Array.from({length:reconnaissanceLimits.entries}, (_, index) => t.put('file-' + index + '.txt', '')));
  const bounded = await repositoryOverview(root, signal);
  expect(bounded.content).toContain('entry limit');
  expect(bounded.content).not.toContain('file-');
});

it('saves the proportional one-step plan and preserves its authoritative status in SQLite', async () => {
  const t = await fixture();
  await t.put('app.ts', source);
  const inspect = range(1), proposal = plan([evidence(inspect,'app.ts',{symbol:'greet',excerpt:'return "Hello"'})]);
  t.replies.push(inspect, proposal, done);
  await t.run();
  const saved = t.store.plan(t.chat.id);
  expect(saved).toMatchObject({version:1,phases:[{steps:[{id:'s',status:'pending'}]}]});
  expect(saved.phases[0].steps[0]).not.toHaveProperty('sources');
  expect(overview(t.requests[0])?.content).toContain('greet');
  expect(overview(t.requests[1])).toEqual(overview(t.requests[0]));
  expect(resultOf(t.requests[1],inspect)).toMatchObject({ok:true,data:{planEvidenceCallId:id(inspect),nextLine:2}});
  expect(resultOf(t.requests[2],proposal).ok).toBe(true);
  const reopened = new Store(t.filename);
  try { expect(reopened.plan(t.chat.id)).toEqual(saved); }
  finally { reopened.close(); }
});

it.each(['uninspected', 'range', 'truncated', 'failed', 'stale', 'excluded', 'wrong-path', 'other-chat', 'other-run', 'step-omitted'] as const)(
  'refuses %s evidence without a plan revision, delegated effect or approval',
  async kind => {
    const t = await fixture();
    await t.put('app.ts', kind === 'truncated' ? 'a'.repeat(65_000) : source);
    await t.put('other.ts', source);
    await mkdir(path.join(t.root,'data'));
    await t.put('data/private.txt','private fixture');
    const inspected = kind === 'failed' ? 'missing.ts' : kind === 'excluded' ? 'data/private.txt' : 'app.ts';
    const inspect = kind === 'range' ? range(1) : read(inspected);
    const structure = kind === 'step-omitted'
      ? [{...phases[0], steps:[...phases[0].steps,{id:'second',title:'Modify related code',status:'pending' as const}]}]
      : phases;
    const proposal = plan(kind === 'uninspected' ? [] : [
      evidence(inspect, kind === 'wrong-path' ? 'other.ts' : inspected, kind === 'range' ? {symbol:'hidden'} : {}),
    ], structure);
    if (kind === 'other-chat' || kind === 'other-run') {
      const first = kind === 'other-chat' ? t.store.createChat(t.project.id,'Other','review') : t.chat;
      t.replies.push(inspect,done);
      await t.run('/plan Inspect original source', first.id);
    } else if (kind !== 'uninspected') {
      t.replies.push(inspect);
    }
    t.replies.push(async () => {
      if (kind === 'stale') await t.put('app.ts', 'export function replacement() {}\n');
      return proposal;
    }, done);
    await t.run();
    const refusal = resultOf(t.requests.at(-1)!, proposal);
    expect(refusal.ok).toBe(false);
    expect(refusal.output).toMatch(/read|sources?|evidence|inspect|excluded/i);
    expect(t.store.plan(t.chat.id)).toEqual({phases:[]});
    expect(t.store.events(t.chat.id).filter(event => ['plan','delegation','file_changed','command'].includes(event.type))).toEqual([]);
    expect(t.store.approvals(t.chat.id)).toEqual([]);
    if (kind === 'truncated') expect(resultOf(t.requests.at(-1)!, inspect).truncated).toBe(true);
  },
);

it.each([true, false])('binds proposed new files to authoritative absence, with existing source present = %s', async expires => {
  const t = await fixture();
  if (expires) await t.put('app.ts', source);
  const inspectNew = nativeReply('inspect_new_plan_path',{path:'new.ts'}), existing = read();
  const admission = [{phaseId:'p',stepId:'s',sources:expires ? evidence(existing).sources : [],
    newFiles:[{path:'new.ts',callId:id(inspectNew)}],checks:[check('new.ts')]}];
  const proposal = plan(admission);
  if (expires) t.replies.push(existing);
  t.replies.push(inspectNew, async () => {
    if (expires) await t.put('new.ts','Introduced after inspection');
    return proposal;
  }, done);
  await t.run();
  expect(resultOf(t.requests.at(-1)!,inspectNew)).toMatchObject({ok:true,data:{state:'absent',planEvidenceCallId:id(inspectNew)}});
  expect(resultOf(t.requests.at(-1)!, proposal).ok).toBe(!expires);
  expect(t.store.plan(t.chat.id).version).toBe(expires ? undefined : 1);
});

it('checks file identity again at the plan transition and leaves goal scope untouched on refusal', async () => {
  const t = await fixture();
  await t.put('app.ts', source);
  const original = t.store.revisePlan(t.chat.id,{phases:[{...phases[0],title:'Original saved plan'}]});
  const inspect = read(), proposal = plan([evidence(inspect)]);
  const validate = t.tools.planningRoot.bind(t.tools);
  let planRootChecks = 0;
  t.replies.push(inspect, () => {
    vi.spyOn(t.tools, 'planningRoot').mockImplementation(root => {
      if (++planRootChecks === 2) writeFileSync(path.join(t.root,'app.ts'),'Concurrent file replacement');
      return validate(root);
    });
    return proposal;
  },nativeReply('ask_user',{question:'Await original scope confirmation.'}));
  await t.run('/goal Preserve original requirement\n- Observe original work');
  expect(resultOf(t.requests.at(-1)!, proposal)).toMatchObject({ok:false,output:expect.stringContaining('changed before commit')});
  expect(t.store.plan(t.chat.id)).toEqual(original);
  expect(goalOf(t.store,t.chat.id)?.requiredSteps.map(step => step.title)).toEqual(['Update greeting']);
  expect(t.store.events(t.chat.id).filter(event => event.type === 'plan')).toHaveLength(1);
  expect(await readFile(path.join(t.root,'app.ts'),'utf8')).toBe('Concurrent file replacement');
});

it('admits multiple evidenced steps, including the dependency excerpt and a proposed file', async () => {
  const t = await fixture();
  await t.put('app.ts', source);
  await t.put('package.json', '{"dependencies":{"react":"1"}}');
  const app = range(2), manifest = read('package.json'), absent = nativeReply('inspect_new_plan_path',{path:'widget.ts'});
  const second = {id:'second',title:'Build the widget',status:'pending' as const};
  const scope = {...evidence(manifest,'package.json',{excerpt:'"react":"1"'}),stepId:second.id,
    newFiles:[{path:'widget.ts',callId:id(absent)}],checks:[{...check('widget.ts'),method:'test'}]};
  const proposal = plan([evidence(app,'app.ts',{symbol:'hidden'}),scope],
    [{...phases[0],steps:[...phases[0].steps,second]}]);
  t.replies.push(app,manifest,absent,proposal,done);
  await t.run();
  expect(resultOf(t.requests.at(-1)!,proposal).ok).toBe(true);
  expect(t.store.plan(t.chat.id).phases[0].steps.map(step => step.id)).toEqual(['s','second']);
  await expect(readFile(path.join(t.root,'widget.ts'))).rejects.toMatchObject({code:'ENOENT'});
});

it.each([true, false])('allows bounded additions to large plans and requires evidence for renamed retained steps, rename = %s', async rename => {
  const t = await fixture();
  await t.put('app.ts', source);
  const prior = {id:'retained',title:'Ongoing work',steps:Array.from({length:18}, (_, index) => ({
    id:'prior-' + index,title:'Existing step ' + index,status:'pending' as const,
  }))};
  const before = t.store.revisePlan(t.chat.id,{phases:[prior]});
  const retained = structuredClone(prior);
  if (rename) retained.steps[0].title = 'Reframed existing step';
  const inspect = read(), proposal = plan([evidence(inspect)],[retained, ...phases]);
  t.replies.push(inspect,proposal,done);
  await t.run();
  expect(resultOf(t.requests.at(-1)!,proposal).ok).toBe(!rename);
  expect(t.store.plan(t.chat.id).version).toBe(rename ? before.version : before.version! + 1);
  expect(t.store.plan(t.chat.id).phases[0].steps).toEqual(prior.steps);
});

it('rolls back a qualifying plan and success result when the SQLite COMMIT fails', async () => {
  const t = await fixture();
  await t.put('app.ts', source);
  const inspect = read(), proposal = plan([evidence(inspect)]);
  const commit = t.store.db.exec.bind(t.store.db), save = t.store.setPlan.bind(t.store);
  let armed = false, injected = false;
  t.replies.push(inspect, () => {
    vi.spyOn(t.store,'setPlan').mockImplementation((chat, proposed) => {
      save(chat,proposed);
      armed = true;
    });
    vi.spyOn(t.store.db,'exec').mockImplementation(sql => {
      if (sql === 'COMMIT' && armed) {
        armed = false;
        injected = true;
        throw new Error('Controlled plan COMMIT failure');
      }
      return commit(sql);
    });
    return proposal;
  }, done);
  await t.run();
  expect(injected).toBe(true);
  expect(resultOf(t.requests.at(-1)!, proposal).ok).toBe(false);
  expect(t.store.plan(t.chat.id)).toEqual({phases:[]});
  expect(t.store.events(t.chat.id).filter(event => event.type === 'plan')).toEqual([]);
});

it('clears a saved plan without granting building or erasing protected goal requirements and plan history', async () => {
  const t = await fixture();
  const original = t.store.revisePlan(t.chat.id,{phases});
  const ref = {planId:original.id!,planVersion:original.version!,phaseId:'p',stepId:'s'};
  t.store.progress(t.chat.id,ref,'original','in_progress','started','Original work');
  t.store.progress(t.chat.id,ref,'original','done','accepted','Original accepted evidence');
  const events = t.store.events(t.chat.id).filter(event => event.type === 'plan_progress');
  t.replies.push(done,done);
  await t.run('/plan Retain planning mode');
  await t.run('/goal Preserve original obligations\n- Keep original evidence');
  const originalGoal = goalOf(t.store,t.chat.id)!;
  const clear = nativeReply('set_plan',{phases:[]});
  t.replies.push(clear,done);
  await t.run('/plan Clear the saved plan');
  expect(resultOf(t.requests.at(-1)!,clear).ok).toBe(true);
  const saved = t.store.plan(t.chat.id);
  expect(saved).toEqual({id:original.id,version:original.version! + 1,phases:[]});
  expect(goalOf(t.store,t.chat.id)?.requiredSteps).toEqual(originalGoal.requiredSteps);
  expect(goalOf(t.store,t.chat.id)?.criteria).toEqual(originalGoal.criteria);
  expect(t.store.events(t.chat.id).filter(event => event.type === 'plan_progress')).toEqual(events);
  const modeVersion = t.store.chat(t.chat.id).modeVersion!;
  await expect(t.runtime.startBuilding(t.chat.id,{planId:original.id!,planVersion:original.version!,modeVersion})).rejects.toMatchObject({statusCode:409});
  await expect(t.runtime.startBuilding(t.chat.id,{planId:saved.id!,planVersion:saved.version!,modeVersion})).rejects.toMatchObject({statusCode:409});
  await expect(t.runtime.submit(t.chat.id,'Start building')).rejects.toMatchObject({statusCode:409});
  expect(t.store.chat(t.chat.id).mode).toBe('plan');
  expect(t.store.getState('build:'+t.chat.id,null)).toBeNull();
  expect(t.store.events(t.chat.id).filter(event => event.type === 'delegation')).toEqual([]);
});

it('preserves the current successful plan revision and exact acceptance on a no-op without receipts', async () => {
  const t = await fixture();
  const saved = t.store.revisePlan(t.chat.id,{phases});
  const ref = {planId:saved.id!,planVersion:saved.version!,phaseId:'p',stepId:'s'};
  t.store.progress(t.chat.id,ref,'original','in_progress','started','Started work');
  t.store.progress(t.chat.id,ref,'original','done','accepted','Reviewed original work');
  const accepted = t.store.plan(t.chat.id);
  const proposal = nativeReply('set_plan',{phases});
  t.replies.push(proposal,done);
  await t.run();
  expect(resultOf(t.requests.at(-1)!,proposal).ok).toBe(true);
  expect(t.store.plan(t.chat.id)).toEqual(accepted);
});
