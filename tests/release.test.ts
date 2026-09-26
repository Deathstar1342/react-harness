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
async function fixture(responses: AgentResponse[], mode: ApprovalMode = 'review') {
  const root = await directory(), projectRoot = path.join(root, 'project');
  await mkdir(projectRoot);
  const config = readConfig({ STARK_BASE_URL: 'http://127.0.0.1/v1', STARK_API_KEY: 'synthetic-test-key', HARNESS_DATA_DIR: path.join(root, 'state') });
  const store = new Store(path.join(config.dataDir, 'state.sqlite'));
  const requests: Parameters<ModelProvider['complete']>[0][] = [];
  const provider: ModelProvider = { models: async () => ['fixture'], complete: async input => {
    requests.push(input);
    const response = responses.shift();
    if (!response) throw new Error('Unexpected fixture model request');
    return { text: JSON.stringify(response), finishReason: 'stop', usage: { inputTokens: 50, outputTokens: 20 } };
  } };
  const tools = new WorkspaceTools();
  const app = await createApp({ config, store, provider, tools, hooks: createManagedHooks(provider, store, config) });
  cleanup.push(async () => { await app.app.close(); store.close(); });
  const project = store.createProject('Synthetic release fixture', projectRoot);
  const chat = store.createChat(project.id, 'Release fixture', mode);
  const post = (url: string, payload: Record<string,unknown>) => app.app.inject({ method: 'POST', url, payload });
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
