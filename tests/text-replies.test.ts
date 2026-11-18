import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { PackageHelperPreview } from '../shared/types.js';
import { reviewInstall } from '../server/install-review.js';
import { readConfig } from '../server/config.js';
import { createManagedHooks } from '../server/context.js';
import { ConnectionDiagnostics } from '../server/diagnostics.js';
import { StarkProvider } from '../server/provider.js';
import { Runtime } from '../server/runtime.js';
import { BUDGET_STATE_KEY, type Reservation } from '../server/scheduler.js';
import { Store } from '../server/store.js';
import { WorkspaceTools } from '../server/tools/index.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const reply = (action: string | null, parameters: object, message = '') => JSON.stringify({ message, action, parameters });
type WireMessage = { role: string; content: string };
type WireInput = { model: string; stream: boolean; messages: WireMessage[] };
type ResponseScript = (input: WireInput) => { text: string; finish?: 'stop' | 'length' } | Response;

function textProvider(script: ResponseScript) {
  const requests: WireInput[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toMatch(/^https:\/\/provider\.invalid\/v1\/(models|chat\/completions)$/);
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'text-model' }] });
    const body = JSON.parse(String(init.body)) as WireInput;
    requests.push(body);
    if ('tools' in body || 'tool_choice' in body || 'functions' in body ||
        body.messages.some(message => !['system', 'user', 'assistant'].includes(message.role) ||
          Object.keys(message).sort().join(',') !== 'content,role')) {
      return new Response(null, { status: 400 });
    }
    const result = script(body);
    if (result instanceof Response) return result;
    if (body.stream) {
      const event = (delta: object, finish: string | null) => 'data: ' + JSON.stringify({
        choices: [{ index: 0, delta, finish_reason: finish }],
      }) + '\n\n';
      return new Response(event({content:result.text.slice(0,15)},null) +
        event({content:result.text.slice(15)},null) + event({},result.finish ?? 'stop') +
        'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({
      choices: [{ message: { role: 'assistant', content: result.text }, finish_reason: result.finish ?? 'stop' }],
      usage: { prompt_tokens: 600, completion_tokens: 50 },
    });
  }));
  return { requests, provider: new StarkProvider({ baseUrl: 'https://provider.invalid/v1', apiKey: 'synthetic-test-key', streaming: false, maxRetries: 0 }) };
}

async function fixture(script: ResponseScript, approvalMode: 'autonomous' | 'review' = 'autonomous') {
  const { provider, requests } = textProvider(script);
  const base = await mkdtemp(path.join(tmpdir(), 'text-replies-'));
  const home = path.join(base, 'profile'), root = path.join(base, 'project');
  await mkdir(home, { mode: 0o700 });
  await mkdir(root);
  await writeFile(path.join(root, 'sample.txt'), 'fixture observation');
  const store = new Store(path.join(home, 'state.sqlite'));
  const config = readConfig({
    HARNESS_HOME: home, HARNESS_WORKSPACE_ROOT: path.join(base, 'managed'), STARK_BASE_URL: 'https://provider.invalid/v1',
    STARK_API_KEY: 'synthetic-test-key', ARCHITECT_MODEL: 'text-model', CODER_MODEL: 'text-model', CRITIC_MODEL: 'text-model',
  });
  const workspace = new WorkspaceTools();
  const actions = vi.spyOn(workspace, 'execute');
  const hooks = createManagedHooks(provider, store, config, { textJSON: true });
  const runtime = new Runtime(store, provider, workspace, config, hooks);
  const project = store.createProject('text fixture', root);
  const chat = store.createChat(project.id, 'text fixture', approvalMode);
  cleanups.push(async () => { await runtime.close(); await workspace.dispose(); store.close(); await rm(base,{recursive:true,force:true}); });
  const submit = async (text = 'Check the file.') => { await runtime.submit(chat.id,text); await runtime.wait(chat.id); };
  const outcomes = () => store.db.prepare("SELECT json_extract(data,'$.outcome') AS outcome FROM inspector_requests WHERE chat_id=? ORDER BY seq")
    .all(chat.id).map(row=>row.outcome);
  return { provider, requests, store, chat, actions, config, hooks, runtime, root, submit, outcomes };
}

it('budgets each repair and executes the first complete, allowed action once', async () => {
  const next = [
    '{"message":"invalid partial","action":"read_file"',
    '{"message":"invalid duplicate","action":"read_file","action":"run_shell","parameters":{"path":"sample.txt"}}',
    reply('read_file',{path:'sample.txt'}),
    reply(null,{},'The file was inspected.'),
  ];
  const t = await fixture(() => ({ text:next.shift()! }));
  await t.submit();

  expect(t.requests).toHaveLength(4);
  expect(t.requests[0].messages[0].content).toContain('Allowed actions');
  expect(t.requests[1].messages.at(-1)?.content).toContain('previous response was rejected');
  expect(t.requests[2].messages.at(-1)?.content).toContain('previous response was rejected');
  expect(t.requests[3].messages.at(-1)?.content).toContain('fixture observation');
  expect(t.requests[3].messages.at(-1)?.content).toContain('never human steering');
  expect(JSON.stringify(t.requests)).not.toContain('invalid duplicate');
  expect(t.actions.mock.calls.map(([,action])=>action.name)).toEqual(['read_file']);
  expect(t.outcomes()).toEqual(['malformed','malformed','returned','returned']);
  expect(t.store.getState<Reservation[]>(BUDGET_STATE_KEY,[]).map(row=>[row.status,row.tokens]))
    .toEqual(Array.from({length:4},()=>['reported',650]));
  expect(t.store.messages(t.chat.id).at(-1)?.content).toBe('The file was inspected.');
  expect(t.store.chat(t.chat.id).status).toBe('idle');
});

it('stops after three malformed or role-forbidden replies without storing their content', async () => {
  const next = [
    reply('run_shell',{command:'SYNTHETIC_DO_NOT_RUN'}),
    'I can help. ' + reply('read_file',{path:'sample.txt'}),
    reply('read_file',{path:'sample.txt',unrecognized:true}),
  ];
  const t = await fixture(() => ({ text:next.shift()! }));
  await t.submit();
  expect(t.requests).toHaveLength(3);
  expect(t.actions).not.toHaveBeenCalled();
  expect(t.outcomes()).toEqual(['malformed','malformed','malformed']);
  expect(t.store.chat(t.chat.id).status).toBe('error');
  expect(t.store.messages(t.chat.id).at(-1)?.content).toContain('No action from those replies was started');
  expect(JSON.stringify(t.store.events(t.chat.id))).not.toContain('SYNTHETIC_DO_NOT_RUN');
});

it('does not repair a provider truncation or HTTP refusal', async () => {
  const truncated = await fixture(() => ({ text:'{"message":',finish:'length' }));
  await truncated.submit();
  expect(truncated.requests).toHaveLength(1);
  expect(truncated.outcomes()).toEqual(['truncated']);
  expect(truncated.actions).not.toHaveBeenCalled();

  const refused = await fixture(() => new Response(null,{status:429}));
  await refused.submit();
  expect(refused.requests).toHaveLength(1);
  expect(refused.outcomes()).toEqual(['http']);
  expect(refused.actions).not.toHaveBeenCalled();
});

it('reaches the existing human file approval gate from a coder text action', async () => {
  const t = await fixture(input => {
    const role = JSON.parse(input.messages.find(message=>message.content.startsWith('Authoritative task state'))!.content.split('\n')[1]).role;
    if (role === 'architect') return {text:reply('delegate',{objective:'Create safe.txt',acceptanceCriteria:['safe.txt exists'],paths:['safe.txt']})};
    if (role === 'coder') return {text:reply('write_file',{path:'safe.txt',content:'controlled',baseHash:null})};
    throw new Error('Unexpected fixture request');
  },'review');
  await t.submit('Create safe.txt in this project.');
  expect(t.requests).toHaveLength(2);
  expect(t.requests[1].messages[0].content).toContain('write_file');
  expect(t.store.chat(t.chat.id).status).toBe('awaiting_approval');
  expect(t.store.approvals(t.chat.id)).toHaveLength(1);
  expect(t.actions).not.toHaveBeenCalled();
  await expect(readFile(path.join(t.root,'safe.txt'))).rejects.toMatchObject({code:'ENOENT'});
});

it('repairs a critic reply that tries to leave the read-only review role', async () => {
  const next = [
    reply('review',{focus:'Assess the project evidence'}),
    reply('write_file',{path:'sample.txt',content:'forbidden',baseHash:null}),
    reply('review_result',{verdict:'pass',findings:['Observed evidence remains unchanged.']}),
    reply(null,{},'Review finished.'),
  ];
  const t = await fixture(() => ({text:next.shift()!}));
  await t.submit('Review the project evidence.');
  expect(t.requests).toHaveLength(4);
  expect(t.requests[2].messages.at(-1)?.content).toContain('previous response was rejected');
  expect(t.outcomes()).toEqual(['returned','malformed','returned','returned']);
  expect(t.store.events(t.chat.id).some(event=>event.type==='review')).toBe(true);
  expect(t.actions).not.toHaveBeenCalled();
  expect(await readFile(path.join(t.root,'sample.txt'),'utf8')).toBe('fixture observation');
});

it('reports ordinary, JSON and streaming JSON checks without claiming native capability', async () => {
  const t = await fixture(input => ({
    text: input.messages.at(-1)?.content.includes('bare JSON') ? '{"value":"Connection OK"}' : 'Connection OK',
  }));
  const diagnostics = new ConnectionDiagnostics(t.config,t.provider,t.hooks.complete!,10_000,true);
  const result = await diagnostics.run();
  expect(result.checks.filter(check=>check.status!=='passed')).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.checks.map(check=>check.evidence)).toEqual([undefined,'ordinary','json','streaming','ordinary','json','streaming','ordinary','json','streaming']);
  expect(t.requests).toHaveLength(9);
  expect(t.requests.filter(input=>input.stream)).toHaveLength(3);
});

it('accepts only a valid advisory install decision and never repairs an invalid review', async () => {
  const valid = reply('install_decision',{decision:'reject',reason:'The preview does not meet the requested need.'});
  const next = [valid,reply(null,{},'Unsafe prose advice')];
  const t = await fixture(() => ({ text:next.shift()! }));
  const preview: PackageHelperPreview = {
    target:{id:'test',installationId:'test',machineId:'test',distribution:'debian',release:'12',architecture:'amd64',manager:'apt',adapterVersion:1},
    packages:[],stateDigest:'fixture',repositoryDigest:'fixture',
    impact:{newPackages:0,downloadBytes:0,installedBytes:0,removals:0,upgrades:0,downgrades:0,
      maintainerScripts:'trusted-package-root-execution',triggers:'may-modify-existing-packages-and-services',serviceChanges:'package-defined'},
  };
  const review = () => reviewInstall(t.hooks.complete!, 'text-model', preview, 'Synthetic package review', new AbortController().signal);
  expect(await review()).toEqual({decision:'reject',reason:'The preview does not meet the requested need.'});
  expect(await review()).toMatchObject({decision:'ask'});
  expect(t.requests).toHaveLength(2);
  expect(t.actions).not.toHaveBeenCalled();
});
