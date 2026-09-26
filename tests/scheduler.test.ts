import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { BUDGET_STATE_KEY, BudgetScheduler, estimateTokens, type Reservation, type SchedulerOptions } from '../server/scheduler.js';
import type { CompletionResult } from '../shared/types.js';

const stores: Store[] = [], dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const limits = { requestsPerMinute: 10, tokensPerMinute: 1000, tokensPerDay: 10000 };
const done = async (): Promise<CompletionResult> => ({ text: 'complete' });
function setup(overrides = {}, options: SchedulerOptions = {}) {
  const store = new Store(':memory:'); stores.push(store);
  let time = 0;
  const scheduler = new BudgetScheduler(store, { ...limits, ...overrides }, { now: () => time, sleep: async ms => { time += ms; }, ...options });
  return { store, scheduler, setTime: (value: number) => { time = value; }, time: () => time, ledger: () => store.getState<Reservation[]>(BUDGET_STATE_KEY, []) };
}
describe('durable account scheduling', () => {
  it('reserves before dispatch and reconciles reported usage', async () => {
    const t = setup();
    await t.scheduler.complete('architect', 100, async () => {
      expect(t.ledger()).toMatchObject([{ status: 'pending', tokens: 100, requests: 1 }]);
      return { text: 'ok', usage: { inputTokens: 30, outputTokens: 10 } };
    });
    expect(t.ledger()).toMatchObject([{ status: 'reported', tokens: 40 }]);
    await t.scheduler.complete('critic', 100, done);
    expect(t.ledger()[1]).toMatchObject({ status: 'estimated', tokens: 100 });
  });
  it('keeps over-estimate reported usage and uncertain failure charges', async () => {
    const t = setup();
    await t.scheduler.complete('architect', 100, async () => ({ text: 'ok', usage: { inputTokens: 300, outputTokens: 50 } }));
    await expect(t.scheduler.complete('control', 100, async () => { throw new Error('HTTP 429'); })).rejects.toThrow('HTTP 429');
    expect(t.ledger().map(item => [item.tokens, item.status])).toEqual([[350, 'reported'], [100, 'uncertain']]);
    await t.scheduler.complete('critic', 100, async () => ({ text: 'ok', usage: { inputTokens: -1, outputTokens: 0 } }));
    expect(t.ledger()[2].tokens).toBe(100);
  });
  it('honors exact rolling minute boundaries instead of calendar resets', async () => {
    const t = setup({ requestsPerMinute: 1 });
    t.setTime(59999);
    await t.scheduler.complete('architect', 100, done);
    t.setTime(60000);
    await t.scheduler.complete('critic', 100, done);
    expect(t.time()).toBe(120000);
    expect(t.ledger()).toHaveLength(2);
  });
  it('holds pending usage across minute boundaries and charges completion time', async () => {
    const t = setup({ requestsPerMinute: 1 }, { requestTimeoutMs: 180000, maxWaitMs: 10 });
    let resolve!: (value: CompletionResult) => void;
    const active = t.scheduler.complete('architect', 100, () => new Promise(r => { resolve = r; }));
    await Promise.resolve();
    t.setTime(61000);
    await expect(t.scheduler.complete('critic', 100, done)).rejects.toThrow('unavailable');
    resolve({ text: 'ok' }); await active;
    expect(t.ledger()[0].chargedAt).toBe(61010);
  });
  it('reserves minute/day token and request headroom for interactive/control roles', async () => {
    const t = setup({ requestsPerMinute: 5, tokensPerMinute: 500, tokensPerDay: 500 }, { maxWaitMs: 1 });
    for (let i = 0; i < 4; i++) await t.scheduler.complete('coder', 100, done);
    await expect(t.scheduler.complete('coder', 1, done)).rejects.toThrow('unavailable');
    await t.scheduler.complete('control', 100, done);
    expect(t.ledger()).toHaveLength(5);
    expect(t.ledger().at(-1)?.role).toBe('control');
  });
  it('bounds waiting for daily capacity then releases at the rolling day boundary', async () => {
    const t = setup({ tokensPerDay: 100 }, { maxWaitMs: 5 });
    await t.scheduler.complete('architect', 100, done);
    t.setTime(60000);
    await expect(t.scheduler.complete('critic', 1, done)).rejects.toThrow('unavailable');
    expect(t.time()).toBe(60005);
    t.setTime(86400000);
    await t.scheduler.complete('critic', 100, done);
    expect(t.ledger()).toHaveLength(1);
  });
  it('rejects impossible requests immediately without sending or sleeping', async () => {
    const wait = vi.fn(), invoke = vi.fn(done);
    const t = setup({}, { sleep: wait });
    await expect(t.scheduler.complete('architect', 1001, invoke)).rejects.toThrow('cannot fit');
    await expect(t.scheduler.complete('coder', 801, invoke)).rejects.toThrow('cannot fit');
    expect(wait).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled(); expect(t.ledger()).toEqual([]);
  });
  it('allows a one-million-token reservation under the configured 1.5M TPM', async () => {
    const t = setup({ requestsPerMinute: 120, tokensPerMinute: 1500000, tokensPerDay: 150000000 });
    await t.scheduler.complete('coder', 1016384, done);
    expect(t.ledger()[0]).toMatchObject({ tokens: 1016384, requests: 1 });
  });
  it('serializes reservations across SQLite connections and keeps a concurrent control slot', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scheduler-')); dirs.push(dir);
    const first = new Store(path.join(dir, 'state.db')), second = new Store(path.join(dir, 'state.db')); stores.push(first, second);
    const options = { maxConcurrent: 2, maxWaitMs: 1, sleep: async () => {}, now: (() => { let tick = 0; return () => tick++; })() };
    const a = new BudgetScheduler(first, limits, options), b = new BudgetScheduler(second, limits, options);
    let resolve!: (value: CompletionResult) => void;
    const active = a.complete('coder', 100, () => new Promise(r => { resolve = r; })); await Promise.resolve();
    await expect(b.complete('coder', 100, done)).rejects.toThrow('unavailable');
    await b.complete('critic', 100, done);
    resolve({ text: 'ok' }); await active;
    expect(first.getState<Reservation[]>(BUDGET_STATE_KEY, [])).toHaveLength(2);
  });
  it('preserves restart-uncertain reservations without replay or immediate refund', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scheduler-restart-')); dirs.push(dir);
    const file = path.join(dir, 'state.db'), old = new Store(file);
    old.setState(BUDGET_STATE_KEY, [{ id: 'interrupted', role: 'coder', requests: 1, tokens: 100, estimate: 100, startedAt: 0, chargedAt: 0, deadline: 120000, status: 'pending' }]);
    old.close();
    const fresh = new Store(file); stores.push(fresh);
    let time = 120000;
    const scheduler = new BudgetScheduler(fresh, { ...limits, requestsPerMinute: 1, tokensPerDay: 100 }, { now: () => time, maxWaitMs: 1, sleep: async ms => { time += ms; } });
    const invoke = vi.fn(done);
    await expect(scheduler.complete('architect', 100, invoke)).rejects.toThrow('unavailable');
    expect(invoke).not.toHaveBeenCalled();
    expect(fresh.getState<Reservation[]>(BUDGET_STATE_KEY, [])[0]).toMatchObject({ status: 'uncertain', chargedAt: 120000, tokens: 100 });
    time = 120000 + 86400000;
    await scheduler.complete('architect', 100, invoke); expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('aborts queued requests without reserving or invoking a provider', async () => {
    const controller = new AbortController(), invoke = vi.fn(done);
    const t = setup({ requestsPerMinute: 1 }, { sleep: async () => { controller.abort(); } });
    await t.scheduler.complete('architect', 100, done);
    await expect(t.scheduler.complete('critic', 100, invoke, controller.signal)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled(); expect(t.ledger()).toHaveLength(1);
  });
  it('cancels in-flight requests, keeps uncertain charges, and ignores late completion', async () => {
    const t = setup(), controller = new AbortController();
    let resolve!: (value: CompletionResult) => void, providerSignal!: AbortSignal;
    const pending = t.scheduler.complete('architect', 100, signal => { providerSignal = signal; return new Promise(r => { resolve = r; }); }, controller.signal);
    await Promise.resolve(); controller.abort();
    await expect(pending).rejects.toThrow('cancelled'); expect(providerSignal.aborted).toBe(true);
    resolve({ text: 'late', usage: { inputTokens: 1, outputTokens: 1 } }); await Promise.resolve();
    expect(t.ledger()[0]).toMatchObject({ status: 'uncertain', tokens: 100 });
  });
  it('times out providers which fail to honor abort without hanging the queue', async () => {
    vi.useFakeTimers();
    const t = setup({}, { requestTimeoutMs: 10 });
    const pending = t.scheduler.complete('architect', 100, () => new Promise(() => {}));
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10); await assertion;
    expect(t.ledger()[0].status).toBe('uncertain');
  });
  it('estimates UTF-8 conservatively and rejects invalid budgets', () => {
    expect(estimateTokens([{ role: 'user', content: '😀' }])).toBe(36);
    expect(() => setup({ tokensPerMinute: 0 })).toThrow('positive');
  });
});
