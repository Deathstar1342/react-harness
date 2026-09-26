import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentResponse, ApprovalMode, ModelProvider } from '../shared/types.js';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { createManagedHooks } from '../server/context.js';
import type { RunState } from '../server/runtime.js';
import { Store } from '../server/store.js';
import { WorkspaceTools } from '../server/tools/index.js';
import { BUDGET_STATE_KEY, type Reservation } from '../server/scheduler.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const action = (name: string, args: Record<string, unknown>): AgentResponse => ({ version: 1, type: 'action', message: '', action: { name, args } });
const final = (message = 'Fixture finished'): AgentResponse => ({ version: 1, type: 'final', message });
const delegate = () => action('delegate', { objective: 'Write the label', acceptanceCriteria: ['Preserve user constraints'], paths: ['label.txt'] });
const write = (content: string, baseHash: string | null = null) => action('write_file', { path: 'label.txt', content, baseHash });
const verdict = () => action('review_result', { verdict: 'pass', findings: [] });
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-release-'));
  cleanup.push(async () => {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('harness-release-')) throw new Error('Unexpected cleanup root');
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
async function fixture(responses: Array<AgentResponse | (() => Promise<AgentResponse>)>, mode: ApprovalMode = 'review') {
  const root = await directory(), projectRoot = path.join(root, 'project');
  await mkdir(projectRoot);
  const config = readConfig({ STARK_BASE_URL: 'http://127.0.0.1/v1', STARK_API_KEY: 'synthetic-test-key', HARNESS_DATA_DIR: path.join(root, 'state') });
  const store = new Store(path.join(config.dataDir, 'state.sqlite'));
  const requests: Parameters<ModelProvider['complete']>[0][] = [];
  const provider: ModelProvider = { models: async () => ['fixture'], complete: async input => {
    requests.push(input);
    const response = responses.shift();
    if (!response) throw new Error('Unexpected fixture model request');
    return { text: JSON.stringify(typeof response === 'function' ? await response() : response), finishReason: 'stop', usage: { inputTokens: 50, outputTokens: 20 } };
  } };
  const tools = new WorkspaceTools();
  const app = await createApp({ config, store, provider, tools, hooks: createManagedHooks(provider, store, config) });
  cleanup.push(async () => { await app.app.close(); store.close(); });
  const project = store.createProject('Synthetic release fixture', projectRoot);
  const chat = store.createChat(project.id, 'Release fixture', mode);
  const post = (url: string, payload: Record<string, unknown>) => app.app.inject({ method: 'POST', url, payload });
  const submit = async (content: string) => {
    expect((await post(`/api/chats/${chat.id}/messages`, { content })).statusCode).toBe(202);
    await app.runtime.wait(chat.id);
  };
  return { ...app, project, chat, tools, responses, requests, config, post, submit };
}

describe('M6 independent release integration', () => {
  it('keeps literal Git filenames from expanding into protected credential diffs', async () => {
    const root = await directory();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
    git('init', '--initial-branch=main');
    await writeFile(path.join(root, '[.]env'), 'safe original\n');
    await writeFile(path.join(root, '.env'), 'SYNTHETIC_SECRET=original\n');
    git('add', '--all');
    git('-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic fixture');
    await writeFile(path.join(root, '[.]env'), 'safe changed\n');
    await writeFile(path.join(root, '.env'), 'SYNTHETIC_SECRET=must-never-appear\n');
    const tools = new WorkspaceTools();
    cleanup.push(() => tools.dispose());
    const result = await tools.execute({ projectRoot: root, chatId: 'fixture', agentId: 'fixture' }, { name: 'git_diff', args: {} });
    expect(result.ok).toBe(true);
    expect(result.output).not.toContain('SYNTHETIC_SECRET');
    expect(result.output).toContain('safe changed');
  });

  it('treats /plan guidance on an existing run as a runtime mutation prohibition', async () => {
    const t = await fixture([delegate(), write('obsolete proposal'), write('must not execute'), final(), verdict(), final()]);
    await t.submit('Implement a label');
    expect(t.store.chat(t.chat.id).status).toBe('awaiting_approval');
    // Switching to autonomy ensures the invariant is runtime plan-only enforcement,
    // rather than a second approval accidentally masking the violation.
    expect((await t.app.inject({ method: 'PATCH', url: `/api/chats/${t.chat.id}`, payload: { approvalMode: 'autonomous' } })).statusCode).toBe(200);
    await t.submit('/plan Explain the remaining changes without applying them');
    expect((await t.tools.read(t.project.path, 'label.txt')).hash).toBeNull();
    expect(t.store.getState<RunState | null>(`run:${t.chat.id}`, null)?.planOnly).toBe(true);
  });

  it('notifies a sibling chat and invalidates its proposal after an agent write', async () => {
    const t = await fixture([delegate(), write('agent update'), final(), verdict(), final()], 'autonomous');
    const sibling = t.store.createChat(t.project.id, 'Sibling', 'review');
    const proposal = write('sibling stale proposal').action!;
    t.store.setState(`run:${sibling.id}`, { planOnly: false, steps: 0, generation: 0, steering: [], frames: [
      { id: 'sibling-coder', role: 'coder', messages: [], repairs: 0, pending: { id: 'sibling-op', stage: 'prepared', action: proposal, approvalId: 'sibling-approval' } },
    ] } satisfies RunState);
    t.store.approval({ id: 'sibling-approval', chatId: sibling.id, agentId: 'sibling-coder', action: proposal, inspection: { effect: 'write', risk: 'routine', description: 'Sibling proposal' }, status: 'pending', createdAt: new Date().toISOString() });
    // Paused prevents unrelated automatic provider work; notification still must persist.
    t.store.updateChat(sibling.id, { status: 'paused' });
    expect((await t.app.inject(`/api/chats/${sibling.id}`)).statusCode).toBe(200);
    await t.submit('Write the label');
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(await readFile(path.join(t.project.path, 'label.txt'), 'utf8')).toBe('agent update');
    expect(t.store.events(sibling.id).some(event => event.type === 'file_changed')).toBe(true);
    expect(t.store.getApproval('sibling-approval').status).toBe('stale');
    expect(t.store.chat(sibling.id).status).toBe('paused');
  });

  it('rejects editor conflicts through the API and preserves protection across a save', async () => {
    const t = await fixture([]);
    const initial = await t.tools.save(t.project.path, 'label.txt', 'initial', null);
    expect((await t.post(`/api/projects/${t.project.id}/editor`, { path: 'label.txt', owner: 'tab-a', dirty: true })).statusCode).toBe(200);
    const save = (owner: string, content: string, baseHash: string | null) => t.app.inject({ method: 'PUT', url: `/api/projects/${t.project.id}/file`, payload: { path: 'label.txt', owner, content, baseHash } });
    expect((await save('tab-b', 'conflict', initial.hash)).statusCode).toBe(409);
    const saved = await save('tab-a', 'manual', initial.hash);
    expect(saved.statusCode).toBe(200);
    expect((await t.tools.execute({ projectRoot: t.project.path, chatId: t.chat.id, agentId: 'coder' }, write('overwrite', saved.json().hash).action!)).ok).toBe(false);
    expect((await t.post(`/api/projects/${t.project.id}/editor`, { path: 'label.txt', owner: 'tab-a', dirty: false })).statusCode).toBe(200);
    expect((await save('tab-b', 'stale', initial.hash)).statusCode).toBe(409);
    expect(await readFile(path.join(t.project.path, 'label.txt'), 'utf8')).toBe('manual');
  });

  it('enforces denied approval and records all role requests in the shared scheduler', async () => {
    const t = await fixture([delegate(), write('must not execute'), final('Denied edit preserved'), verdict(), final('No change applied')]);
    await t.submit('Propose an edit');
    const approval = t.store.approvals(t.chat.id)[0];
    expect((await t.post(`/api/approvals/${approval.id}`, { decision: 'deny' })).statusCode).toBe(200);
    await t.runtime.wait(t.chat.id);
    expect((await t.tools.read(t.project.path, 'label.txt')).hash).toBeNull();
    expect(t.store.getApproval(approval.id).status).toBe('denied');
    expect(t.store.chat(t.chat.id).status).toBe('idle');
    const ledger = t.store.getState<Reservation[]>(BUDGET_STATE_KEY, []);
    expect(ledger).toHaveLength(t.requests.length);
    expect(new Set(ledger.map(item => item.role))).toEqual(new Set(['architect', 'coder', 'critic']));
    expect(ledger.every(item => item.status === 'reported' && item.tokens === 70)).toBe(true);
  });
});


describe('M6 recovery and context follow-up', () => {
  it('keeps historical approved diffs out of authoritative context capacity', async () => {
    const t = await fixture([final('Small follow-up answered')]);
    t.config.contextLimits.architect = 24000;
    t.config.maxOutputTokens = 256;
    // Legitimately completed approvals remain in audit history. Their large diffs
    // must not become noncompactable controls for every subsequent request.
    for (let index = 0; index < 8; index++) {
      const content = `Historical edit ${index}: ${'x'.repeat(1500)}`;
      t.store.approval({ id: `historical-${index}`, chatId: t.chat.id, agentId: 'retired-coder', action: write(content).action!, inspection: { effect: 'write', risk: 'routine', description: 'Completed historical edit', before: content, after: content, diff: content }, status: 'approved', createdAt: new Date().toISOString() });
    }
    await t.submit('Give a short status update');
    expect(t.store.chat(t.chat.id).status).toBe('idle');
    expect(t.requests).toHaveLength(1);
    expect(t.store.approvals(t.chat.id)).toHaveLength(8);
    expect(t.store.approvals(t.chat.id).every(item => item.status === 'approved')).toBe(true);
  });

  it('cancels a provider response before accepting its otherwise valid write proposal', async () => {
    let entered!: () => void, resolve!: (value: AgentResponse) => void;
    const started = new Promise<void>(done => { entered = done; });
    const t = await fixture([delegate(), () => { entered(); return new Promise(done => { resolve = done; }); }], 'autonomous');
    expect((await t.post(`/api/chats/${t.chat.id}/messages`, { content: 'Write a label' })).statusCode).toBe(202);
    await started;
    expect((await t.post(`/api/chats/${t.chat.id}/control`, { action: 'interrupt' })).statusCode).toBe(200);
    resolve(write('late cancelled response'));
    await Promise.resolve();
    expect(t.store.chat(t.chat.id).status).toBe('interrupted');
    expect((await t.tools.read(t.project.path, 'label.txt')).hash).toBeNull();
    expect(t.store.events(t.chat.id).filter(event => event.type === 'tool')).toEqual([]);
    expect(t.store.getState<Reservation[]>(BUDGET_STATE_KEY, []).at(-1)?.status).toBe('uncertain');
    t.responses.push(final('No edit made'), verdict(), final('Cancellation respected'));
    expect((await t.post(`/api/chats/${t.chat.id}/control`, { action: 'resume' })).statusCode).toBe(200);
    await t.runtime.wait(t.chat.id);
    expect(t.store.chat(t.chat.id).status).toBe('idle');
    expect((await t.tools.read(t.project.path, 'label.txt')).hash).toBeNull();
  });

  it('does not replay a durable executing shell after reopening the database', async () => {
    const t = await fixture([]);
    t.store.setState(`run:${t.chat.id}`, { planOnly: false, steps: 1, generation: 0, steering: [], frames: [
      { id: 'architect', role: 'architect', messages: [], repairs: 0 },
      { id: 'coder', role: 'coder', messages: [], repairs: 0, pending: { id: 'uncertain-operation', stage: 'executing', action: action('run_shell', { command: 'synthetic command which must never be sent to the shell' }).action! } },
    ] } satisfies RunState);
    t.store.updateChat(t.chat.id, { status: 'running' });
    await t.app.close();
    // A second Store connection loads persisted run state, independent of the
    // first Runtime cache, just as process restart does. No shell is invoked.
    const reopened = new Store(path.join(t.config.dataDir, 'state.sqlite'));
    const tools = new WorkspaceTools();
    const responses = [verdict(), final('Inspected uncertain outcome'), verdict(), final('No command replayed')];
    const provider: ModelProvider = { models: async () => [], complete: async () => {
      const response = responses.shift();
      if (!response) throw new Error('Unexpected recovery request');
      return { text: JSON.stringify(response) };
    } };
    const next = await createApp({ config: t.config, store: reopened, tools, provider, hooks: createManagedHooks(provider, reopened, t.config) });
    cleanup.push(async () => { await next.app.close(); reopened.close(); });
    let executions = 0;
    const execute = tools.execute.bind(tools);
    tools.execute = async (...args) => { executions++; return execute(...args); };
    expect(reopened.chat(t.chat.id).status).toBe('interrupted');
    expect((await next.app.inject({ method: 'POST', url: `/api/chats/${t.chat.id}/control`, payload: { action: 'resume' } })).statusCode).toBe(200);
    await next.runtime.wait(t.chat.id);
    expect(executions).toBe(0);
    expect(reopened.chat(t.chat.id).status).toBe('idle');
    expect(reopened.messages(t.chat.id).some(message => message.role === 'tool' && message.content.includes('NOT been rerun'))).toBe(true);
  });
});

describe('M6 HTTP streaming and change observation', () => {
  it('replays SSE after Last-Event-ID and closes open streams on backend shutdown', async () => {
    const t = await fixture([]);
    const earlier = t.store.event(t.chat.id, 'steering', { content: 'already seen', delivered: true });
    const later = t.store.event(t.chat.id, 'steering', { content: 'must replay', delivered: true });
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const address = t.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/chats/${t.chat.id}/events?after=0`, { headers: { 'Last-Event-ID': String(earlier.id) }, signal: controller.signal });
    const reader = response.body!.getReader();
    try {
      expect(response.status).toBe(200);
      let text = '';
      while (!text.includes(': connected')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Stream ended before replay');
        text += new TextDecoder().decode(chunk.value);
      }
      expect(text).toContain(`id: ${later.id}`);
      expect(text).toContain('must replay');
      expect(text).not.toContain('already seen');
      const closed = t.app.close();
      while (!(await reader.read()).done) { /* Drain to the explicit server end. */ }
      await closed;
      expect(t.store.changes.listenerCount(t.chat.id)).toBe(0);
    } finally { controller.abort(); await reader.cancel().catch(() => {}); }
  });

  it('observes a real external save immediately after an editor save to the same file', async () => {
    const t = await fixture([]);
    // Opening detail starts the real project watcher before either save.
    expect((await t.app.inject(`/api/chats/${t.chat.id}`)).statusCode).toBe(200);
    const saved = await t.app.inject({ method: 'PUT', url: `/api/projects/${t.project.id}/file`, payload: { path: 'label.txt', owner: 'tab', content: 'editor version', baseHash: null } });
    expect(saved.statusCode).toBe(200);
    await writeFile(path.join(t.project.path, 'label.txt'), 'external version');
    await new Promise(resolve => setTimeout(resolve, 450));
    expect(await readFile(path.join(t.project.path, 'label.txt'), 'utf8')).toBe('external version');
    const changes = t.store.events(t.chat.id).filter(event => event.type === 'file_changed').map(event => event.data as { path: string; source: string });
    expect(changes).toContainEqual({ path: 'label.txt', source: 'editor' });
    expect(changes).toContainEqual({ path: 'label.txt', source: 'external' });
  });
});
