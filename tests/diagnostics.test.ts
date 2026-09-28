import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionDiagnostics } from '../server/diagnostics.js';
import { readConfig } from '../server/config.js';
import { createManagedHooks } from '../server/context.js';
import { Store } from '../server/store.js';
import { BUDGET_STATE_KEY, BudgetError, type Reservation } from '../server/scheduler.js';
import { ProviderError } from '../server/provider.js';
import type { CompletionResult, ModelProvider } from '../shared/types.js';

const config = readConfig({ STARK_BASE_URL: 'http://127.0.0.1/v1', STARK_API_KEY: 'secret-never-disclose', ARCHITECT_MODEL: 'a', CODER_MODEL: 'c', CRITIC_MODEL: 'r' });
const good: CompletionResult = { text: JSON.stringify({ version: 1, type: 'final', message: 'Connection OK' }), finishReason: 'stop', usage: { inputTokens: 15, outputTokens: 10 } };
const stores: Store[] = [];
afterEach(() => { vi.useRealTimers(); for (const store of stores.splice(0)) store.close(); });
function fixture(overrides: Partial<ModelProvider> = {}, timeout = 25000, options = config) {
  const store = new Store(':memory:'); stores.push(store);
  const provider: ModelProvider = { models: vi.fn(async () => ['a', 'c', 'r']), complete: vi.fn(async () => good), ...overrides };
  const hooks = createManagedHooks(provider, store, options);
  return { store, provider, diagnostics: new ConnectionDiagnostics(options, provider, hooks.complete!, timeout) };
}

describe('bounded, isolated connection diagnostics', () => {
  it('checks exact IDs, uses normal managed completion and accounts for all three role probes', async () => {
    const t = fixture();
    const result = await t.diagnostics.run();
    expect(result.ok).toBe(true);
    expect(result.checks.map(check => check.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(t.provider.complete).toHaveBeenCalledTimes(3);
    for (const [index, call] of vi.mocked(t.provider.complete).mock.calls.entries()) {
      expect(call[0]).toMatchObject({ model: ['a', 'c', 'r'][index], maxTokens: 1024 });
      expect(call[0].signal).toBeInstanceOf(AbortSignal);
      expect(call[0].onDelta).toBeUndefined();
      expect(JSON.stringify(call[0])).not.toContain(config.apiKey);
    }
    expect(t.store.getState<Reservation[]>(BUDGET_STATE_KEY, []).map(entry => [entry.role, entry.tokens, entry.status]))
      .toEqual([['architect', 25, 'reported'], ['coder', 25, 'reported'], ['critic', 25, 'reported']]);
    expect(t.store.chats()).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('Connection OK');
  });
  it('does not probe missing or near-match IDs, but still checks available roles', async () => {
    const t = fixture({ models: async () => ['A', 'c', 'r-extra'] });
    const report = await t.diagnostics.run();
    expect(report.checks.map(check => check.status)).toEqual(['passed', 'failed', 'passed', 'failed']);
    expect(t.provider.complete).toHaveBeenCalledTimes(1);
    expect(vi.mocked(t.provider.complete).mock.calls[0][0].model).toBe('c');
  });
  it('does not send requests when unconfigured or when catalog retrieval fails', async () => {
    const unconfigured = fixture({}, 25000, { ...config, apiKey: '' });
    expect((await unconfigured.diagnostics.run()).checks.map(check => check.status)).toEqual(['failed', 'skipped', 'skipped', 'skipped']);
    expect(unconfigured.provider.models).not.toHaveBeenCalled();
    expect(unconfigured.provider.complete).not.toHaveBeenCalled();
    const failed = fixture({ models: async () => { throw new Error(config.apiKey + ' upstream private payload'); } });
    const report = await failed.diagnostics.run();
    expect(report.ok).toBe(false);
    expect(failed.provider.complete).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toMatch(/secret-never-disclose|upstream private payload/);
  });
  it.each([
    '{"version":1,"type":"final","message":"secret-never-disclose"',
    JSON.stringify({ version: 1, type: 'final', message: 'Connection OK', 'secret-never-disclose': true }),
    JSON.stringify({ version: 1, type: 'action', message: 'secret-never-disclose', action: { name: 'run_shell', args: { command: 'NEVER EXECUTE' } } }),
    JSON.stringify({ version: 1, type: 'message', message: 'Connection OK' }),
    'I refuse: secret-never-disclose',
  ])('rejects malformed, unexpected and action replies without exposing them: %s', async text => {
    const t = fixture({ complete: async () => ({ text }) });
    const report = await t.diagnostics.run();
    expect(report.ok).toBe(false);
    expect(report.checks.slice(1).every(check => check.status === 'failed')).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/secret-never-disclose|NEVER EXECUTE|run_shell/);
    expect(t.store.chats()).toEqual([]);
  });
  it.each([
    [new ProviderError('refusal', config.apiKey), 'refused'],
    [new ProviderError('truncated', config.apiKey), 'output limit'],
    [new ProviderError('timeout', config.apiKey), 'timed out'],
    [new ProviderError('http', config.apiKey, 401), 'authentication'],
    [new ProviderError('http', config.apiKey, 429), 'rate limit'],
    [new BudgetError(config.apiKey), 'budget'],
    [new Error('parser details ' + config.apiKey), 'configuration'],
  ])('returns only fixed safe failure text for %s', async (error, expected) => {
    const t = fixture({ complete: async () => { throw error; } });
    const report = await t.diagnostics.run();
    expect(report.checks[1].message).toContain(expected);
    expect(JSON.stringify(report)).not.toContain(config.apiKey);
  });
  it.each([{ ...good, finishReason: 'length' }, { text: 'x'.repeat(2049) }])('bounds output and rejects incomplete finishes', async reply => {
    const t = fixture({ complete: async () => reply });
    expect((await t.diagnostics.run()).checks[1]).toMatchObject({ status: 'failed', message: 'Test reply was incomplete or exceeded its size limit.' });
  });
  it('honors configured output caps and rejects probes that cannot fit account budgets', async () => {
    const t = fixture({}, 25000, { ...config, maxOutputTokens: 64 });
    await t.diagnostics.run();
    expect(vi.mocked(t.provider.complete).mock.calls[0][0].maxTokens).toBe(64);
    const blocked = fixture({}, 25000, { ...config, limits: { requestsPerMinute: 120, tokensPerMinute: 1, tokensPerDay: 1 } });
    expect((await blocked.diagnostics.run()).checks[1].message).toContain('budget');
    expect(blocked.provider.complete).not.toHaveBeenCalled();
  });
  it('counts failed transport attempts conservatively without retrying', async () => {
    const t = fixture({ complete: vi.fn(async () => { throw new Error('failed'); }) });
    await t.diagnostics.run();
    expect(t.provider.complete).toHaveBeenCalledTimes(3);
    expect(t.store.getState<Reservation[]>(BUDGET_STATE_KEY, []).every(entry => entry.status === 'uncertain' && entry.tokens > 1024)).toBe(true);
  });
  it('cancels a hung catalog, rejects concurrency and permits a later check', async () => {
    let catalogSignal: AbortSignal | undefined;
    const t = fixture({ models: vi.fn(signal => { catalogSignal = signal; return new Promise<never>(() => {}); }) });
    const controller = new AbortController();
    const pending = t.diagnostics.run(controller.signal);
    await vi.waitFor(() => expect(catalogSignal).toBeDefined());
    expect(() => t.diagnostics.run()).toThrow('already running');
    controller.abort();
    expect((await pending).checks.map(check => check.status)).toEqual(['failed', 'skipped', 'skipped', 'skipped']);
    expect(catalogSignal!.aborted).toBe(true);
    vi.mocked(t.provider.models).mockResolvedValue(['a', 'c', 'r']);
    expect((await t.diagnostics.run()).ok).toBe(true);
  });
  it('includes account queue waits in the total deadline and sends no unreserved probe', async () => {
    vi.useFakeTimers();
    const t = fixture({}, 50);
    t.store.setState(BUDGET_STATE_KEY, [{ id: 'other-chat', role: 'architect', requests: 120, tokens: 1, estimate: 1, startedAt: Date.now(), chargedAt: Date.now(), deadline: Date.now() + 120000, status: 'pending' }]);
    const pending = t.diagnostics.run();
    await vi.advanceTimersByTimeAsync(51);
    const report = await pending;
    expect(report.checks.map(check => check.status)).toEqual(['passed', 'failed', 'skipped', 'skipped']);
    expect(report.checks[1].message).toContain('timed out');
    expect(t.provider.complete).not.toHaveBeenCalled();
  });
  it.each(['catalog', 'completion'])('enforces the total deadline while %s ignores cancellation', async phase => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const t = fixture(phase === 'catalog'
      ? { models: async signal => { requestSignal = signal; return new Promise<never>(() => {}); } }
      : { complete: async input => { requestSignal = input.signal; return new Promise<never>(() => {}); } }, 50);
    const pending = t.diagnostics.run();
    await vi.advanceTimersByTimeAsync(51);
    const report = await pending;
    expect(requestSignal?.aborted).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.checks[phase === 'catalog' ? 0 : 1].message).toContain('timed out');
    expect(report.checks.slice(phase === 'catalog' ? 1 : 2).every(check => check.status === 'skipped')).toBe(true);
    await t.diagnostics.close();
  });
  it('bounds a hung completion, settles reservation on abort, and stops subsequent probes on shutdown', async () => {
    let probeSignal: AbortSignal | undefined;
    const t = fixture({ complete: vi.fn(input => { probeSignal = input.signal; return new Promise<never>(() => {}); }) });
    const pending = t.diagnostics.run();
    await vi.waitFor(() => expect(probeSignal).toBeDefined());
    await t.diagnostics.close();
    expect(probeSignal!.aborted).toBe(true);
    expect((await pending).checks.map(check => check.status)).toEqual(['passed', 'failed', 'skipped', 'skipped']);
    expect(t.provider.complete).toHaveBeenCalledTimes(1);
    expect(t.store.getState<Reservation[]>(BUDGET_STATE_KEY, [])[0].status).toBe('uncertain');
    expect(() => t.diagnostics.run()).toThrow('shutting down');
  });
});
