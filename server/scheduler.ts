import { randomUUID } from 'node:crypto';
import type { AgentRole, CompletionResult, ModelMessage, PublicSettings } from '../shared/types.js';
import { Store } from './store.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
export const BUDGET_STATE_KEY = 'scheduler:account:v1';
export type RequestRole = AgentRole | 'control';
export interface Reservation {
  id: string; role: RequestRole; requests: number; tokens: number; estimate: number;
  startedAt: number; chargedAt: number; deadline: number;
  status: 'pending' | 'reported' | 'estimated' | 'uncertain';
}
export interface SchedulerOptions {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxWaitMs?: number;
  requestTimeoutMs?: number;
  maxConcurrent?: number;
}
export class BudgetError extends Error {
  constructor(message: string) { super(message); this.name = 'BudgetError'; }
}

// One token per UTF-8 byte plus message framing is deliberately conservative in
// the absence of a provider tokenizer (including non-ASCII and code).
export function estimateTokens(messages: ModelMessage[]): number {
  return 16 + messages.reduce((total, message) => total + 16 + Buffer.byteLength(message.content, 'utf8'), 0);
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Scheduled request cancelled')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new BudgetError(`${name} must be a positive safe integer`);
  return value;
}

/** One ledger per backend account/database. The supplied provider MUST disable internal retries; each invocation represents one transport attempt. */
export class BudgetScheduler {
  private readonly now: () => number;
  private readonly wait: NonNullable<SchedulerOptions['sleep']>;
  private readonly maxWait: number;
  private readonly timeout: number;
  private readonly concurrent: number;
  constructor(private readonly store: Store, private readonly limits: PublicSettings['limits'], options: SchedulerOptions = {}) {
    for (const [name, value] of Object.entries(limits)) positive(value, name);
    this.now = options.now ?? Date.now;
    this.wait = options.sleep ?? sleep;
    this.maxWait = positive(options.maxWaitMs ?? MINUTE, 'maxWaitMs');
    this.timeout = positive(options.requestTimeoutMs ?? 120_000, 'requestTimeoutMs');
    if (this.timeout > 2_147_483_647) throw new BudgetError('requestTimeoutMs exceeds timer limits');
    this.concurrent = positive(options.maxConcurrent ?? 4, 'maxConcurrent');
  }
  private ledger(now: number): Reservation[] {
    return this.store.getState<Reservation[]>(BUDGET_STATE_KEY, []).map(item =>
      item.status === 'pending' && now >= item.deadline
        ? { ...item, status: 'uncertain' as const, chargedAt: item.deadline } : item
    ).filter(item => item.status === 'pending' || now < item.chargedAt + DAY);
  }
  private caps(role: RequestRole) {
    const fraction = role === 'coder' ? 0.8 : 1;
    return {
      requests: Math.floor(this.limits.requestsPerMinute * fraction),
      minute: Math.floor(this.limits.tokensPerMinute * fraction),
      day: Math.floor(this.limits.tokensPerDay * fraction),
    };
  }
  private reserve(role: RequestRole, estimate: number): Reservation | undefined {
    const now = this.now(), caps = this.caps(role);
    return this.store.transaction(() => {
      const ledger = this.ledger(now);
      const pending = ledger.filter(item => item.status === 'pending');
      const minute = ledger.filter(item => item.status === 'pending' || now < item.chargedAt + MINUTE);
      const tokens = estimate;
      const fits = minute.reduce((sum, item) => sum + item.requests, 0) + 1 <= caps.requests &&
        minute.reduce((sum, item) => sum + item.tokens, 0) + tokens <= caps.minute &&
        ledger.reduce((sum, item) => sum + item.tokens, 0) + tokens <= caps.day &&
        pending.length < this.concurrent &&
        (role !== 'coder' || pending.filter(item => item.role === 'coder').length < Math.max(1, this.concurrent - 1));
      const reservation: Reservation | undefined = fits ? {
        id: randomUUID(), role, requests: 1, tokens, estimate, startedAt: now, chargedAt: now,
        deadline: now + this.timeout, status: 'pending',
      } : undefined;
      if (reservation) ledger.push(reservation);
      this.store.setState(BUDGET_STATE_KEY, ledger);
      return reservation;
    });
  }
  private settle(id: string, result?: CompletionResult) {
    this.store.transaction(() => {
      const now = this.now(), ledger = this.ledger(now), entry = ledger.find(item => item.id === id);
      if (!entry) return;
      const usage = result?.usage;
      const valid = usage && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0 &&
        Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0 &&
        Number.isSafeInteger(usage.inputTokens + usage.outputTokens);
      entry.tokens = valid ? usage.inputTokens + usage.outputTokens : entry.tokens;
      entry.status = valid ? 'reported' : result ? 'estimated' : 'uncertain';
      // Charge at settlement so attempts/retries spanning a window cannot escape
      // the rolling limit. Aborted/failed requests may still have been billed.
      entry.chargedAt = now;
      this.store.setState(BUDGET_STATE_KEY, ledger);
    });
  }
  async complete(role: RequestRole, estimate: number, invoke: (signal: AbortSignal) => Promise<CompletionResult>, signal?: AbortSignal): Promise<CompletionResult> {
    positive(estimate, 'Estimated tokens');
    const caps = this.caps(role), tokens = estimate;
    if (!Number.isSafeInteger(tokens) || caps.requests < 1 || tokens > caps.minute || tokens > caps.day) {
      throw new BudgetError('Request cannot fit account budgets (including coder headroom). Reduce context/output or increase configured limits.');
    }
    signal?.throwIfAborted();
    const started = this.now();
    let reservation = this.reserve(role, estimate);
    while (!reservation) {
      signal?.throwIfAborted();
      const remaining = this.maxWait - (this.now() - started);
      if (remaining <= 0) throw new BudgetError('Account budget or concurrency capacity is unavailable. Request was not sent; retry after capacity recovers.');
      await this.wait(Math.min(1000, remaining), signal);
      signal?.throwIfAborted();
      reservation = this.reserve(role, estimate);
    }
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('Scheduled request cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new BudgetError('Scheduled provider request timed out')), this.timeout);
    let rejectAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
      if (controller.signal.aborted) rejectAbort();
    });
    try {
      const result = await Promise.race([Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return invoke(controller.signal);
      }), aborted]);
      controller.signal.throwIfAborted();
      this.settle(reservation.id, result);
      return result;
    } catch (error) {
      this.settle(reservation.id);
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', rejectAbort);
    }
  }
}
