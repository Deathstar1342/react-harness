import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { readConfig } from '../server/config.js';
import { createManagedHooks } from '../server/context.js';
import { inspectorView } from '../server/inspector.js';
import { ReloadingProvider } from '../server/provider.js';
import { Runtime } from '../server/runtime.js';
import { BUDGET_STATE_KEY, estimateTokens, type Reservation } from '../server/scheduler.js';
import { Store } from '../server/store.js';
import { WorkspaceTools } from '../server/tools/index.js';
import type { AgentRole, CompletionResult, InspectorRequest, ModelMessage, NativeToolCall, NativeToolDefinition } from '../shared/types.js';
import { nativeReply } from './native-fixture.js';
import { envCanaryKey, envCanaryValue, oraclePath, oracleSource, reportPath, scenarios, sentinel, snapshot, type Scenario } from './local-llm-evaluation-fixtures.js';

const model = 'fixture-model';
const apiKey = 'evaluation-only-loopback-bearer';
const baseline = process.env.ABYSSUS_EVALUATION_REF === 'baseline';
const useLocalCommands = true;
const stop: CompletionResult = {text: 'Controlled fixture status.', finishReason: 'stop'};
const done = () => nativeReply('submit_completion', {summary: 'Observe the original fixture receipts.'});
const review = (pass: boolean, findings: string[] = []) => nativeReply('review_result', {verdict: pass ? 'pass' : 'changes_requested', findings});
const sha = (content: string) => createHash('sha256').update(content).digest('hex');
const hash = (content: string | undefined) => content === undefined ? null : sha(content);
const write = (name: string, content: string, before: string | undefined) => nativeReply('write_file', {path: name, baseHash: hash(before), content});
const reads = (names: string[]) => names.map(name => nativeReply('read_file', {path: name}));
const batch = (items: CompletionResult[]): CompletionResult => ({text: '', finishReason: 'tool_calls', toolCalls: items.flatMap(item => item.toolCalls!)});
const tool = (reply: CompletionResult) => reply.toolCalls![0];

interface WireRequest { model: string; messages: ModelMessage[]; tools: NativeToolDefinition[]; max_tokens: number; stream: boolean }
type ResponseKind = CompletionResult | 'reset' | 'refuse' | 'unavailable' | 'timeout';
type Script = { role: AgentRole; respond: (body: WireRequest) => ResponseKind };
type Capture = { role?: AgentRole; body: WireRequest; reply?: string; responseKind?: string };

function git(root: string, ...args: string[]) {
  // Trusted fixture setup only. Agent test execution uses the normal WorkspaceTools boundary.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(path|systemroot|windir|temp|tmp)$/i.test(name)));
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = path.join(root, '.git', 'absent-config');
  const result = spawnSync('git', ['-c', 'core.hooksPath=' + path.join(root, '.git', 'absent-hooks'), ...args], {cwd: root, env, encoding: 'utf8', timeout: 5_000});
  if (result.error || result.status !== 0) throw new Error('Synthetic Git fixture setup failed: ' + (result.error?.message ?? result.stderr));
}

function frame(delta: object, finish: string | null = null) {
  return 'data: ' + JSON.stringify({choices: [{index: 0, delta, finish_reason: finish}]}) + '\n\n';
}

function observedRole(request: WireRequest): AgentRole {
  const state = request.messages.find(m => m.content.startsWith('Authoritative task state'));
  if (!state) throw new Error('Request lacks authoritative role state');
  return JSON.parse(state.content.slice(state.content.indexOf('\n') + 1)).role;
}

async function fixture(id: string, {stream = false, tinyContext = false, tinyAccount = false, timeoutMs = 5_000} = {}) {
  const tempRoot = await realpath(tmpdir());
  const base = await mkdtemp(path.join(tempRoot, 'le-'));
  const workspace = path.join(base, 'repo'), home = path.join(base, 'profile');
  await mkdir(workspace);
  await mkdir(home, {mode: 0o700});
  const store = new Store(path.join(home, 'state.sqlite'));
  const tools = new WorkspaceTools();
  tools.configureWorkspace({home, protectedPaths: [], projects: () => [workspace]});
  const execute = vi.spyOn(tools, 'execute');
  const script: Script[] = [], wire: Capture[] = [], failures: string[] = [];
  const nativeCalls = new Map<string, NativeToolCall>();
  const correlated = new Set<string>();
  let active = 0, highWater = 0;
  const server = http.createServer(async (request, response) => {
    ++active;
    highWater = Math.max(highWater, active);
    let open = true;
    const settle = () => { if (open) { open = false; --active; } };
    response.once('finish', settle);
    response.once('close', settle);
    try {
      const text = await new Promise<string>((resolve, reject) => {
        let size = 0;
        const data: Buffer[] = [];
        request.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > 256_000) { reject(Error('Fixture request exceeded bound')); request.destroy(); }
          else data.push(chunk);
        });
        request.once('end', () => resolve(Buffer.concat(data).toString('utf8')));
        request.once('error', reject);
      });
      const body: WireRequest = JSON.parse(text);
      const capture: Capture = {body};
      wire.push(capture);
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/v1/chat/completions');
      expect(request.headers.authorization === 'Bearer ' + apiKey).toBe(true);
      expect(text.includes(apiKey) || text.includes(envCanaryValue)).toBe(false);
      expect(body.model).toBe(model);
      expect(body.stream).toBe(stream);
      expect(body.max_tokens).toBe(256);
      expect(wire.length).toBeLessThanOrEqual(24);
      for (let i = 0; i < body.messages.length; i++) {
        const message = body.messages[i];
        if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
        for (const [offset, call] of message.tool_calls.entries()) {
          expect(call).toEqual(nativeCalls.get(call.id));
          expect(body.messages[i + offset + 1]).toMatchObject({role: 'tool', tool_call_id: call.id});
          correlated.add(call.id);
        }
      }
      capture.role = observedRole(body);
      const step = script.shift();
      if (!step || step.role !== capture.role) throw Error('Unexpected role/request, expected ' + step?.role + ' and observed ' + capture.role);
      const answer = step.respond(body);
      capture.responseKind = typeof answer === 'string' ? answer : answer.finishReason;
      if (answer === 'timeout') return;
      if (answer === 'unavailable') { response.writeHead(503, {'Retry-After': '0'}).end(); return; }
      if (answer === 'reset') {
        capture.reply = frame({tool_calls: [{index: 0, id: 'cut-call', type: 'function', function: {name: 'read_file', arguments: '{"path":"guard.txt"}'}}]});
        response.writeHead(200, {'Content-Type': 'text/event-stream'}).end(capture.reply);
        return;
      }
      const usage = wire.length % 3 === 1 ? {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0} :
        wire.length % 3 === 2 ? undefined : {prompt_tokens: 11, completion_tokens: 2, total_tokens: 13};
      const refusal = answer === 'refuse';
      const result = refusal ? stop : answer;
      const calls = result.toolCalls ?? [];
      for (const call of calls) nativeCalls.set(call.id, call);
      if (stream) {
        const deltas = calls.map((call, index) => {
          const {name, arguments: args} = call.function;
          const middle = Math.floor(args.length / 2);
          return frame({tool_calls: [{index, id: call.id, type: call.type, function: {name, arguments: args.slice(0, middle)}}]}) +
            frame({tool_calls: [{index, function: {arguments: args.slice(middle)}}]});
        });
        capture.reply = deltas.join('') + (result.text ? frame({content: result.text}) : '') +
          frame({}, result.finishReason!) + (usage ? 'data: ' + JSON.stringify({choices: [], usage}) + '\n\n' : '') + 'data: [DONE]\n\n';
        response.writeHead(200, {'Content-Type': 'text/event-stream'}).end(capture.reply);
      } else {
        const message = {role: 'assistant', content: result.text, ...(refusal ? {refusal: 'Controlled refusal'} : {}), ...(calls.length ? {tool_calls: calls} : {})};
        capture.reply = JSON.stringify({choices: [{index: 0, message, finish_reason: result.finishReason}], usage});
        response.writeHead(200, {'Content-Type': 'application/json'}).end(capture.reply);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : 'Unexpected HTTP fixture failure');
      if (!response.destroyed) response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing loopback address');
  const baseUrl = 'http://127.0.0.1:' + address.port + '/v1';
  const config = readConfig({
    STARK_BASE_URL: baseUrl, STARK_API_KEY: apiKey,
    ARCHITECT_MODEL: model, CODER_MODEL: model, CRITIC_MODEL: model,
    ARCHITECT_INPUT_TOKEN_LIMIT: tinyContext ? '256' : '64000',
    CODER_INPUT_TOKEN_LIMIT: '64000', CRITIC_INPUT_TOKEN_LIMIT: '64000',
    MODEL_MAX_OUTPUT_TOKENS: '256', REQUESTS_PER_MINUTE: '60',
    TOKENS_PER_MINUTE: tinyAccount ? '1' : '1500000', TOKENS_PER_DAY: '10000000',
    HARNESS_HOME: home, HARNESS_DATA_DIR: home, HARNESS_WORKSPACE_ROOT: workspace,
  });
  const provider = new ReloadingProvider(() => ({baseUrl, apiKey, streaming: stream, maxRetries: 0, timeoutMs}));
  const hooks = createManagedHooks(provider, store, config);
  const project = store.createProject('Evaluation fixture', workspace);
  const chat = store.createChat(project.id, 'Controlled benchmark', 'autonomous');
  const runtime = new Runtime(store, provider, tools, config, hooks);
  const events = () => store.events(chat.id);
  const view = () => inspectorView(store, chat.id);
  const requestRows = () => store.db.prepare('SELECT data FROM inspector_requests ORDER BY seq').all().map(row => JSON.parse(String(row.data)) as InspectorRequest);
  const outcomes = async () => Promise.all(execute.mock.results.map(async result => result.type === 'return' ? await result.value : undefined));
  let runElapsedMs: number | undefined;
  return {
    id, base, workspace, store, chat, project, runtime, events, view, requestRows, execute, outcomes, wire, correlated, nativeCalls,
    stage: (role: AgentRole, ...items: (ResponseKind | Script['respond'])[]) =>
      script.push(...items.map(item => ({role, respond: typeof item === 'function' ? item : () => item}))),
    run: async (goal: string) => {
      const started = performance.now();
      try { await runtime.submit(chat.id, goal); await runtime.wait(chat.id); }
      finally { runElapsedMs = performance.now() - started; }
    },
    verify: () => {
      expect(failures).toEqual([]);
      expect(script).toHaveLength(0);
      expect(highWater).toBe(wire.length ? 1 : 0);
      const rows = requestRows().filter(row => row.attempts > 0);
      expect(rows.map(row => row.role)).toEqual(wire.map(request => request.role));
      expect(rows.every(row => row.attempts === 1 && row.model === model && row.purpose === 'conversation')).toBe(true);
      expect(new Set(rows.map(row => row.runId)).size).toBe(wire.length ? 1 : 0);
      expect(JSON.stringify(view()).includes(apiKey) || JSON.stringify(view()).includes(envCanaryValue)).toBe(false);
    },
    close: async (assertionPassed: boolean, metrics: object = {}) => {
      try {
        await runtime.close();
        await tools.dispose();
        const target = process.env.ABYSSUS_EVALUATION_RECEIPTS;
        if (target) {
          const root = await realpath(target);
          const relative = path.relative(await realpath(process.cwd()), root);
          if (!relative || !path.isAbsolute(relative) && !relative.startsWith('..' + path.sep)) throw Error('Private receipts require a directory outside this checkout');
          const requests = requestRows();
          const reservations = store.getState<Reservation[]>(BUDGET_STATE_KEY, []);
          const inspection = view();
          const calls = execute.mock.calls.map(([, action]) => action);
          const results = await outcomes();
          const dispatch = wire.map(({role, body}) => ({role, inputEstimate: estimateTokens(body.messages, body.tools), outputBudget: body.max_tokens}));
          const receipt = {id, assertionPassed, metrics, runElapsedMs, baseline, useLocalCommands, highWater, requests, reservations, dispatch,
            calls, results, events: events(), inspection, wire, failures, remaining: script.map(step => step.role)};
          await writeFile(path.join(root, id + '-' + path.basename(base) + '.json'), JSON.stringify(receipt), {mode: 0o600, flag: 'wx'});
        }
      } finally {
        store.close();
        await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
        if (!process.env.ABYSSUS_EVALUATION_RECEIPTS) await rm(base, {recursive: true, force: true});
      }
    },
  };
}

type Trial = Awaited<ReturnType<typeof fixture>>;

function plan(trial: Trial, scenario: Scenario, names: string[], title: string, allPaths: string[]) {
  const observations = reads(names);
  const absent = allPaths.filter(name => !(name in scenario.initial))
    .map(name => nativeReply('inspect_new_plan_path', {path: name}));
  trial.stage('architect', batch([...observations, ...(baseline ? [] : absent)]));
  const phases = [{id: 'phase', title: 'Evaluation', steps: [{id: 'step', title, status: 'pending'}]}];
  const admission = [{phaseId: 'phase', stepId: 'step', sources: names.map((name, i) => ({path: name, callId: tool(observations[i]).id})),
    newFiles: absent.map(call => ({...JSON.parse(tool(call).function.arguments), callId: tool(call).id})),
    task: {objective: title}, checks: [{method: 'inspection', target: allPaths[0], expected: 'Match the fixture requirements.'}]}];
  trial.stage('architect', nativeReply('set_plan', baseline ? {phases} : {phases, admission}), () => {
    const {id, version} = trial.store.plan(trial.chat.id);
    expect(id).toBeTruthy();
    return nativeReply('delegate', {objective: title, acceptanceCriteria: ['Satisfy fixture checks inside approved paths.'],
      paths: allPaths, planStep: {planId: id, planVersion: version, phaseId: 'phase', stepId: 'step'}});
  });
}

function verifyWithCommand(trial: Trial) {
  if (useLocalCommands) trial.stage('coder', nativeReply('run_tests', {command: 'node ' + oraclePath, reportPath, timeoutMs: 5_000}));
}

function prepare(trial: Trial, scenario: Scenario) {
  const targets = Object.keys(scenario.final);
  if (scenario.conflict) {
    const conflict = scenario.conflict;
    plan(trial, scenario, scenario.planningReads, 'Try the feature boundary first', [conflict]);
    const observation = reads([conflict])[0];
    trial.stage('coder', observation, done());
    if (baseline) {
      // Legacy runtime returns two local repair turns before handing the unresolved assignment to Architect.
      trial.stage('critic', review(false, ['The shared boundary requires revised scope.']));
      for (let i = 0; i < 2; i++) {
        trial.stage('coder', batch([...reads([conflict]), done()]));
        trial.stage('critic', review(false, ['The shared boundary still requires revised scope.']));
      }
    } else {
      trial.stage('critic', () => {
        const original = trial.events().find(event => event.type === 'tool' &&
          (event.data as {reviewReceipt?: {callId?: string}}).reviewReceipt?.callId === tool(observation).id);
        expect(original).toBeDefined();
        return nativeReply('review_result', {verdict: 'changes_requested', findings: [],
          replan: {reason: 'scope_change', explanation: 'Shared rendering is required. Revise the assignment to cover both modules.', evidenceEventIds: [original!.id]}});
      });
    }
    plan(trial, scenario, targets, 'Preserve the shared interface and add the short renderer', targets);
  } else {
    plan(trial, scenario, scenario.planningReads, 'Implement and verify the requested change', targets);
  }
  const sourcePaths = scenario.id === 'dependency' ? scenario.planningReads : targets.filter(name => name in scenario.initial);
  if (sourcePaths.length) trial.stage('coder', batch(reads(sourcePaths)));
  const repair = scenario.repair;
  trial.stage('coder', batch(targets.map(name => write(name, name === repair?.path ? repair.content : scenario.final[name], scenario.initial[name]))));
  if (repair) {
    trial.stage('coder', done());
    trial.stage('critic', batch([...reads([repair.path]), review(false, ['Correct the observed bad local helper identifier.'])]));
    trial.stage('coder', write(repair.path, scenario.final[repair.path], repair.content));
  }
  verifyWithCommand(trial);
  trial.stage('coder', done());
  trial.stage('critic', batch([...reads(targets), review(true)]));
  trial.stage('architect', done());
}

async function runScenario(scenario: Scenario, stream: boolean) {
  const trial = await fixture(scenario.id + (stream ? '-sse' : '-json'), {stream});
  let passed = false;
  const metrics: Record<string, unknown> = {};
  try {
    const initial = {...sentinel, ...scenario.initial, [oraclePath]: oracleSource(scenario), '.env': envCanaryKey + '=' + envCanaryValue + '\n'};
    for (const [name, content] of Object.entries(initial)) {
      const file = path.join(trial.workspace, name);
      await mkdir(path.dirname(file), {recursive: true});
      await writeFile(file, content);
    }
    git(trial.workspace, 'init', '--quiet');
    git(trial.workspace, '-c', 'core.autocrlf=false', 'add', '--', ...Object.keys(initial).filter(name => name !== '.env'));
    const before = await snapshot(trial.workspace);
    expect(before).toEqual(initial);
    prepare(trial, scenario);
    vi.stubEnv(envCanaryKey, envCanaryValue);
    await trial.run(scenario.goal);
    trial.verify();
    const after = await snapshot(trial.workspace);
    const final = {...before, ...scenario.final};
    const commands = trial.execute.mock.calls.filter(([, action]) => action.name === 'run_tests');
    if (useLocalCommands) {
      expect(commands).toHaveLength(1);
      const reports = trial.store.detail(trial.chat.id).tests;
      expect(reports).toMatchObject([{status: 'passed', tests: [{name: 'fixture acceptance', status: 'passed'}]}]);
      expect(trial.view().links.some(link => link.kind === 'tests')).toBe(true);
      expect(after[reportPath]).toBe('<testsuite><testcase name="fixture acceptance"/></testsuite>');
      delete after[reportPath];
    } else {
      expect(commands).toHaveLength(0);
    }
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => before[name] !== after[name]).sort();
    metrics.changed = changed;
    expect(changed).toEqual(Object.keys(scenario.final).sort());
    expect(after).toEqual(final);
    const oracle = createRequire(import.meta.url)(path.join(trial.workspace, oraclePath)) as () => void;
    oracle();
    const changes = trial.store.fileChanges(trial.project.id);
    expect(changes.map(change => change.path).sort()).toEqual([...Object.keys(scenario.final), ...(scenario.repair ? [scenario.repair.path] : [])].sort());
    expect(changes.every(change => change.status === 'confirmed')).toBe(true);
    const stored = trial.store.plan(trial.chat.id);
    const step = stored.phases[0].steps[0];
    expect(step).toMatchObject({status: 'done', evidence: {outcome: 'accepted'}});
    const reviews = trial.events().filter(event => event.type === 'review');
    expect(reviews.at(-1)?.id).toBe(step.evidence?.sourceEventId);
    if (!baseline) {
      const dispositions = reviews.map(event => (event.data as {disposition?: string}).disposition);
      expect(dispositions).toEqual([...(scenario.repair ? ['local_repair'] : []), ...(scenario.conflict ? ['replan'] : []), 'accepted']);
    } else {
      expect(reviews.map(event => (event.data as {passed: boolean}).passed)).toEqual([
        ...(scenario.repair ? [false] : []), ...(scenario.conflict ? [false, false, false] : []), true,
      ]);
    }
    if (scenario.conflict) {
      const firstWrite = trial.events().find(event => event.type === 'file_changed');
      expect(firstWrite?.id).toBeGreaterThan(reviews.at(-2)!.id);
      expect(stored.version).toBe(2);
    }
    const rows = trial.requestRows();
    expect(rows.map(row => row.usageState)).toEqual(rows.map((_row, i) => i % 3 === 1 ? 'unknown' : 'reported'));
    expect(rows[0].usage).toEqual({inputTokens: 0, outputTokens: 0});
    expect(rows.every(row => row.outcome === 'returned' && row.elapsedMs !== null)).toBe(true);
    const first = [...trial.nativeCalls.values()][0];
    expect(first.function.arguments).toBe(JSON.stringify({path: scenario.planningReads[0]}));
    expect(trial.correlated.has(first.id)).toBe(true);
    expect(rows[0].callIds).toContain(first.id);
    const originalRead = trial.store.messages(trial.chat.id).find(message => message.role === 'tool' && message.metadata?.toolCallId === first.id);
    expect(originalRead?.metadata?.ok).toBe(true);
    expect(trial.events().some(event => event.type === 'tool' && (event.data as {messageId?: number}).messageId === originalRead?.id)).toBe(true);
    const wireRepairs = trial.wire.filter((request, index) => request.role === 'critic' && trial.wire[index + 1]?.role === 'coder').length;
    expect(wireRepairs).toBe(scenario.repair ? 1 : scenario.conflict && baseline ? 2 : 0);
    Object.assign(metrics, {accepted: true, oracle: scenario.id.endsWith('ansible') ? 'structural' : 'behavioral', planVersion: stored.version,
      scopeDeviations: 0, repairs: wireRepairs, replans: (stored.version ?? 0) - 1,
      replanDisposition: scenario.conflict ? baseline ? 'unavailable' : 'recorded' : 'not-applicable'});
    passed = true;
  } finally {
    vi.unstubAllEnvs();
    await trial.close(passed, metrics);
  }
}

it.each(scenarios)('accepts $id only after real scoped edits and original review evidence', async scenario => runScenario(scenario, false));
it('round-trips exact native calls with fragmented SSE, reported-zero and missing usage', async () => runScenario(scenarios[0], true));

it.each([
  ['refusal', 'refuse', 'refusal'],
  ['transient HTTP', 'unavailable', 'http'],
  ['truncated SSE', 'reset', 'truncated'],
  ['timeout', 'timeout', 'timeout'],
] as const)('settles %s without replay or dispatching a tool', async (name, reply, outcome) => {
  const trial = await fixture(outcome, {stream: reply === 'reset', timeoutMs: reply === 'timeout' ? 700 : 5_000});
  let passed = false;
  try {
    trial.stage('architect', reply);
    await trial.run('Observe the controlled transport outcome.');
    trial.verify();
    expect(trial.requestRows()).toMatchObject([{role: 'architect', attempts: 1, outcome}]);
    expect(trial.execute).not.toHaveBeenCalled();
    expect(trial.store.fileChanges(trial.project.id)).toEqual([]);
    expect(trial.store.approvals(trial.chat.id)).toEqual([]);
    expect(await snapshot(trial.workspace)).toEqual({});
    passed = true;
  } finally { await trial.close(passed); }
});

it('rejects duplicate argument keys without dispatching either sibling', async () => {
  const trial = await fixture('duplicate-arguments');
  let passed = false;
  try {
    const first = nativeReply('read_file', {path: 'guard.txt'});
    const second = nativeReply('read_file', {path: 'guard.txt'});
    tool(second).function.arguments = '{"path":"guard.txt","path":"other.txt"}';
    trial.stage('architect', batch([first, second]), stop);
    await trial.run('Observe an invalid batch.');
    trial.verify();
    expect(trial.execute).not.toHaveBeenCalled();
    expect(trial.correlated).toEqual(new Set([tool(first).id, tool(second).id]));
    expect(trial.store.messages(trial.chat.id).filter(message => message.role === 'tool').map(message => message.metadata?.ok)).toEqual([false, false]);
    expect(await snapshot(trial.workspace)).toEqual({});
    passed = true;
  } finally { await trial.close(passed); }
});

it('pauses after three text-only Coder turns without native acceptance', async () => {
  const trial = await fixture('missing-native');
  let passed = false;
  try {
    trial.stage('architect', nativeReply('delegate', {objective: 'Observe fixture state', acceptanceCriteria: ['Require native evidence']}));
    trial.stage('coder', stop, stop, stop);
    await trial.run('Inspect the fixture.');
    trial.verify();
    expect(trial.store.chat(trial.chat.id).status).toBe('paused');
    expect(trial.events().filter(event => event.type === 'review')).toEqual([]);
    expect(trial.execute).not.toHaveBeenCalled();
    passed = true;
  } finally { await trial.close(passed); }
});

it('refuses a request exceeding configured context before sending or reserving', async () => {
  const trial = await fixture('context-budget', {tinyContext: true});
  let passed = false;
  try {
    await trial.run('Observe context admission.');
    trial.verify();
    expect(trial.requestRows()).toEqual([]);
    expect(trial.store.getState(BUDGET_STATE_KEY, [])).toEqual([]);
    expect(trial.store.chat(trial.chat.id).status).toBe('error');
    expect(trial.execute).not.toHaveBeenCalled();
    passed = true;
  } finally { await trial.close(passed); }
});

it('refuses an impossible account reservation without an HTTP attempt', async () => {
  const trial = await fixture('account-budget', {tinyAccount: true});
  let passed = false;
  try {
    await trial.run('Observe scheduler admission.');
    trial.verify();
    expect(trial.requestRows()).toMatchObject([{role: 'architect', stage: 'queued', attempts: 0, outcome: 'failed'}]);
    expect(trial.store.getState(BUDGET_STATE_KEY, [])).toEqual([]);
    expect(trial.store.chat(trial.chat.id).status).toBe('error');
    expect(trial.execute).not.toHaveBeenCalled();
    passed = true;
  } finally { await trial.close(passed); }
});
