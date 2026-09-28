import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { createManagedHooks } from '../server/context.js';
import { parseAgentResponse, protocolInstructions } from '../server/protocol.js';
import { StarkProvider } from '../server/provider.js';
import { BUDGET_STATE_KEY, type Reservation } from '../server/scheduler.js';
import { Store } from '../server/store.js';
import type { Chat, ModelProvider, ToolService } from '../shared/types.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const valid = JSON.stringify({ version: 1, type: 'final', message: 'Connection OK' });
const tools: ToolService = { inspect: vi.fn(async () => ({ effect: 'read' as const, risk: 'routine' as const, description: '' })), execute: vi.fn(async () => ({ ok: true, output: '' })), read: async (_root, path) => path === 'AGENTS.md' ? { path, content: '', hash: null } : { path: 'x', content: 'x', hash: 'hash' }, list: async () => [], save: vi.fn(async () => ({ path: 'x', content: '', hash: '' })), setDirty: vi.fn(), dispose: async () => {} };
async function fixture(provider: ModelProvider = { models: async () => ['a', 'c', 'r'], complete: async () => ({ text: valid }) }) {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-m8-'));
  cleanup.push(async () => { if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('harness-m8-')) throw new Error('Unsafe test cleanup'); await rm(root, { recursive: true, force: true }); });
  const config = readConfig({ HARNESS_DATA_DIR: path.join(root, 'state'), HARNESS_WORKSPACE_ROOT: path.join(root, 'workspace'), STARK_BASE_URL: 'http://127.0.0.1/v1', STARK_API_KEY: 'private-diagnostic-key', ARCHITECT_MODEL: 'a', CODER_MODEL: 'c', CRITIC_MODEL: 'r' });
  const build = () => createApp({ config, provider, tools, hooks: { parse: parseAgentResponse, instructions: protocolInstructions } });
  let current = await build();
  const first = current;
  cleanup.push(() => current.app.close());
  return { root, config, first, restart: async () => { await current.app.close(); current = await build(); return current; } };
}

describe('persistent settings and approval scope', () => {
  it('persists preferences across restart, leaves workspace/existing chats intact and applies defaults only to new chats', async () => {
    const t = await fixture();
    const project = t.first.store.createProject('Existing', t.root);
    const old = t.first.store.createChat(project.id, 'Original', 'balanced');
    expect((await t.first.app.inject('/api/preferences')).json()).toEqual({ debugMode: false, defaultApprovalMode: 'balanced' });
    const workspace = (await t.first.app.inject('/api/workspace')).json();
    expect((await t.first.app.inject({ method: 'PATCH', url: '/api/preferences', payload: { debugMode: true, defaultApprovalMode: 'review' } })).statusCode).toBe(200);
    const restarted = await t.restart();
    expect((await restarted.app.inject('/api/preferences')).json()).toEqual({ debugMode: true, defaultApprovalMode: 'review' });
    expect((await restarted.app.inject('/api/workspace')).json()).toEqual(workspace);
    expect(restarted.store.chat(old.id).approvalMode).toBe('balanced');
    const newChat = (await restarted.app.inject({ method: 'POST', url: `/api/projects/${project.id}/chats`, payload: {} })).json<Chat>();
    expect(newChat.approvalMode).toBe('review');
    expect((await restarted.app.inject('/api/settings')).json().approvalMode).toBe('review');
    await restarted.app.inject({ method: 'PATCH', url: `/api/chats/${old.id}`, payload: { approvalMode: 'autonomous' } });
    expect(restarted.store.chat(newChat.id).approvalMode).toBe('review');
    expect((await restarted.app.inject('/api/preferences')).json().defaultApprovalMode).toBe('review');
    await restarted.app.inject({ method: 'PATCH', url: '/api/preferences', payload: { debugMode: false } });
    expect((await restarted.app.inject('/api/preferences')).json()).toEqual({ debugMode: false, defaultApprovalMode: 'review' });
  });
  it('rejects invalid preferences and origin/content-type failures before mutation or probing', async () => {
    const provider: ModelProvider = { models: vi.fn(async () => []), complete: vi.fn(async () => ({ text: valid })) };
    const { first } = await fixture(provider);
    for (const payload of [{ debugMode: 'true' }, { defaultApprovalMode: 'unsafe' }, { streaming: true }, { jsonMode: false }, { apiKey: 'no' }]) {
      expect((await first.app.inject({ method: 'PATCH', url: '/api/preferences', payload })).statusCode).toBe(400);
    }
    for (const url of ['/api/preferences', '/api/connection-check']) {
      const method = url.includes('preferences') ? 'PATCH' : 'POST';
      expect((await first.app.inject({ method, url, headers: { origin: 'https://attacker.example' }, payload: {} })).statusCode).toBe(403);
      expect((await first.app.inject({ method, url, headers: { 'content-type': 'text/plain' }, payload: '{}' })).statusCode).toBe(415);
    }
    expect((await first.app.inject({ method: 'POST', url: '/api/connection-check', payload: { model: 'other' } })).statusCode).toBe(400);
    expect(provider.models).not.toHaveBeenCalled();
    expect((await first.app.inject('/api/preferences')).json().debugMode).toBe(false);
  });
  it('cannot change active or pending-chat approval policy or release any proposal via Settings', async () => {
    const { first, root } = await fixture();
    const project = first.store.createProject('Project', root);
    const chat = first.store.createChat(project.id, 'Pending', 'review');
    for (const status of ['running', 'awaiting_approval'] as const) {
      first.store.updateChat(chat.id, { status });
      expect((await first.app.inject({ method: 'PATCH', url: `/api/chats/${chat.id}`, payload: { approvalMode: 'autonomous' } })).statusCode).toBe(409);
    }
    first.store.updateChat(chat.id, { status: 'paused' });
    first.store.approval({ id: 'pending-proposal', chatId: chat.id, agentId: 'coder', action: { name: 'write_file', args: { path: 'x', content: 'new', baseHash: null } }, inspection: { effect: 'write', risk: 'routine', description: 'Write file' }, status: 'pending', createdAt: new Date().toISOString() });
    expect((await first.app.inject({ method: 'PATCH', url: `/api/chats/${chat.id}`, payload: { approvalMode: 'autonomous' } })).statusCode).toBe(409);
    await first.app.inject({ method: 'PATCH', url: '/api/preferences', payload: { defaultApprovalMode: 'autonomous' } });
    expect(first.store.chat(chat.id).approvalMode).toBe('review');
    expect(first.store.getApproval('pending-proposal').status).toBe('pending');
    expect(tools.execute).not.toHaveBeenCalled();
    expect(tools.save).not.toHaveBeenCalled();
  });
});

describe('connection route transport and lifecycle', () => {
  it.each([true, false])('uses configured streaming=%s, normal transport and shared account usage without executing actions', async streaming => {
    const requests: Record<string, unknown>[] = [];
    const server = http.createServer(async (req, res) => {
      expect(req.headers.authorization).toBe('Bearer private-diagnostic-key');
      if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: ['a', 'c', 'r'].map(id => ({ id })) })); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
      const text = body.model === 'c' ? JSON.stringify({ version: 1, type: 'action', message: 'private-diagnostic-key', action: { name: 'run_shell', args: { command: 'NEVER RUN' } } }) : valid;
      if (streaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 6 } })}\n\ndata: [DONE]\n\n`);
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ index: 0, message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 6 } }));
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
    const config = readConfig({ STARK_BASE_URL: `http://127.0.0.1:${address.port}/v1`, STARK_API_KEY: 'private-diagnostic-key', MODEL_STREAMING: String(streaming), ARCHITECT_MODEL: 'a', CODER_MODEL: 'c', CRITIC_MODEL: 'r' });
    const store = new Store(':memory:');
    const provider = new StarkProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey, streaming, maxRetries: 0 });
    const { app } = await createApp({ config, store, provider, tools, hooks: createManagedHooks(provider, store, config) });
    cleanup.push(async () => { await app.close(); store.close(); });
    const reply = await app.inject({ method: 'POST', url: '/api/connection-check', payload: {} });
    expect(reply.statusCode).toBe(200);
    expect(reply.json().checks.map((item: { status: string }) => item.status)).toEqual(['passed', 'passed', 'failed', 'passed']);
    expect(reply.body).not.toMatch(/private-diagnostic-key|NEVER RUN|run_shell|Connection OK/);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.stream).toBe(streaming);
      expect(request.max_tokens).toBe(1024);
      expect(request).not.toHaveProperty('tools'); expect(request).not.toHaveProperty('response_format');
    }
    expect(store.getState<Reservation[]>(BUDGET_STATE_KEY, []).map(item => item.tokens)).toEqual([11, 11, 11]);
    expect(tools.execute).not.toHaveBeenCalled();
    expect(store.chats()).toEqual([]);
  });
  it('aborts provider work when the HTTP client disconnects, rejects a simultaneous check, and accepts retry', async () => {
    const signals: AbortSignal[] = [];
    const provider: ModelProvider = { models: async signal => { signals.push(signal!); return new Promise(() => {}); }, complete: vi.fn(async () => ({ text: valid })) };
    const { first } = await fixture(provider);
    const address = await first.app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const pending = fetch(address + '/api/connection-check', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' }, signal: controller.signal }).catch(() => undefined);
    await vi.waitFor(() => expect(signals.length).toBe(1));
    expect((await first.app.inject({ method: 'POST', url: '/api/connection-check', payload: {} })).statusCode).toBe(409);
    controller.abort(); await pending;
    await vi.waitFor(() => expect(signals[0].aborted).toBe(true));
    provider.models = async () => ['a', 'c', 'r'];
    await vi.waitFor(async () => expect((await first.app.inject({ method: 'POST', url: '/api/connection-check', payload: {} })).json().ok).toBe(true));
  });
  it('shuts down promptly while a managed probe is hung and settles accounting before store close', async () => {
    let signal: AbortSignal | undefined;
    const { first } = await fixture({ models: async () => ['a', 'c', 'r'], complete: async input => { signal = input.signal; return new Promise(() => {}); } });
    const pending = first.app.inject({ method: 'POST', url: '/api/connection-check', payload: {} });
    void pending.then(() => undefined);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await first.app.close();
    expect(signal!.aborted).toBe(true);
    expect((await pending).json().checks.map((item: { status: string }) => item.status)).toEqual(['passed', 'failed', 'skipped', 'skipped']);
  });
});
