import type { CompletionResult, ModelProvider, ModelUsage } from '../shared/types.js';

type ErrorCode = 'configuration' | 'http' | 'transport' | 'aborted' | 'timeout' | 'malformed' | 'truncated' | 'refusal' | 'limit';
export class ProviderError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}
export interface StarkProviderOptions { baseUrl: string; apiKey: string; streaming?: boolean; timeoutMs?: number; maxRetries?: number }
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FRAME_CHARACTERS = 1024 * 1024;
const MAX_RETRIES = 2;
const malformed = () => new ProviderError('malformed', 'Provider returned an invalid completion payload');
const truncated = () => new ProviderError('truncated', 'Provider completion was truncated or did not finish normally');
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function parseJSON(text: string): unknown {
  try { return JSON.parse(text); } catch { throw malformed(); }
}
function usageFrom(value: unknown): ModelUsage | undefined {
  if (value == null) return undefined;
  if (!record(value)) throw malformed();
  const input = value.prompt_tokens, output = value.completion_tokens;
  if (!Number.isSafeInteger(input) || (input as number) < 0 || !Number.isSafeInteger(output) || (output as number) < 0) throw malformed();
  return { inputTokens: input as number, outputTokens: output as number };
}
function rejectRefusal(value: unknown): void {
  if (value != null && value !== '') throw new ProviderError('refusal', 'Provider refused the completion');
}
function checkFinish(reason: unknown): asserts reason is 'stop' {
  if (reason === 'content_filter') throw new ProviderError('refusal', 'Provider refused the completion');
  if (reason === 'length' || reason == null) throw truncated();
  if (reason !== 'stop') throw malformed();
}
function rejectNativeTools(value: Record<string, unknown>): void {
  if (value.tool_calls != null || value.function_call != null) throw malformed();
}

async function readJSON(response: Response): Promise<unknown> {
  if (!response.body) throw malformed();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '', bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) throw new ProviderError('limit', 'Provider response exceeds the size limit');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return parseJSON(text);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

// Incremental SSE parser: line terminators may span chunks, and data fields are
// joined per event rather than treating each network chunk or data line as JSON.
async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<{ data: string; event: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', data: string[] = [], event = '', frameSize = 0, bytes = 0;
  function line(value: string): { data: string; event: string } | undefined {
    if (value === '') {
      const result = data.length || event === 'error' ? { data: data.join('\n'), event } : undefined;
      data = []; event = ''; frameSize = 0;
      return result;
    }
    frameSize += value.length;
    if (frameSize > MAX_FRAME_CHARACTERS) throw new ProviderError('limit', 'Provider stream event exceeds the size limit');
    if (value.startsWith(':')) return;
    const separator = value.indexOf(':');
    const field = separator < 0 ? value : value.slice(0, separator);
    let content = separator < 0 ? '' : value.slice(separator + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'data') data.push(content);
    if (field === 'event') event = content;
  }
  try {
    while (true) {
      const chunk = await reader.read();
      if (!chunk.done) {
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BYTES) throw new ProviderError('limit', 'Provider response exceeds the size limit');
        pending += decoder.decode(chunk.value, { stream: true });
      } else pending += decoder.decode();
      let start = 0;
      for (let index = 0; index < pending.length; index++) {
        const char = pending[index];
        if (char !== '\n' && char !== '\r') continue;
        if (char === '\r' && index === pending.length - 1 && !chunk.done) break;
        const result = line(pending.slice(start, index));
        if (char === '\r' && pending[index + 1] === '\n') index++;
        start = index + 1;
        if (result) yield result;
      }
      pending = pending.slice(start);
      if (pending.length + frameSize > MAX_FRAME_CHARACTERS) throw new ProviderError('limit', 'Provider stream event exceeds the size limit');
      // EOF does not dispatch an unterminated event. The caller requires [DONE].
      if (chunk.done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new ProviderError('aborted', 'Provider request cancelled')); return; }
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(new ProviderError('aborted', 'Provider request cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class StarkProvider implements ModelProvider {
  #baseUrl: string;
  #apiKey: string;
  #streaming: boolean;
  #timeoutMs: number;
  #maxRetries: number;
  constructor(options: StarkProviderOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#streaming = options.streaming ?? true;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#maxRetries = options.maxRetries ?? MAX_RETRIES;
    if (!Number.isSafeInteger(this.#maxRetries) || this.#maxRetries < 0 || this.#maxRetries > MAX_RETRIES) throw new ProviderError('configuration', 'Provider retry limit must be between zero and two');
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 2_147_483_647) {
      throw new ProviderError('configuration', 'Provider timeout must be a positive integer within timer limits');
    }
  }

  async #request<T>(endpoint: string, init: RequestInit, external: AbortSignal | undefined, consume: (response: Response) => Promise<T>): Promise<T> {
    // Allow an unconfigured application to start; fail safely when it requests a model.
    try {
      const url = new URL(this.#baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !this.#apiKey.trim()) throw new Error();
    } catch { throw new ProviderError('configuration', 'Configure a valid HTTP(S) provider base URL and API key'); }
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(); // Never propagate caller-supplied secret-bearing reasons.
    if (external?.aborted) abort();
    else external?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    try {
      for (let attempt = 0; ; attempt++) {
        controller.signal.throwIfAborted();
        const response = await fetch(`${this.#baseUrl}${endpoint}`, {
          ...init, redirect: 'error', signal: controller.signal,
          headers: { 'Authorization': `Bearer ${this.#apiKey}`, 'Accept': endpoint === '/models' || !this.#streaming ? 'application/json' : 'text/event-stream', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          const retryable = [429, 502, 503, 504].includes(response.status);
          if (retryable && attempt < this.#maxRetries) {
            const retryHeader = response.headers.get('retry-after');
            const numericDelay = retryHeader === null ? NaN : Number(retryHeader) * 1_000;
            const dateDelay = retryHeader === null ? NaN : Date.parse(retryHeader) - Date.now();
            const retryDelay = Number.isFinite(numericDelay) ? numericDelay : dateDelay;
            // Never retry earlier than a valid Retry-After. If it exceeds the
            // operation budget, let the caller/scheduler decide when to resume.
            if (Number.isFinite(retryDelay) && retryDelay > this.#timeoutMs) throw new ProviderError('http', `Provider HTTP request failed (${response.status})`, response.status);
            await wait(Math.max(0, Number.isFinite(retryDelay) ? retryDelay : 250 * 2 ** attempt), controller.signal);
            continue;
          }
          throw new ProviderError('http', `Provider HTTP request failed (${response.status})`, response.status);
        }
        const result = await consume(response);
        controller.signal.throwIfAborted();
        return result;
      }
    } catch (error) {
      if (timedOut) throw new ProviderError('timeout', 'Provider request timed out');
      if (controller.signal.aborted) throw new ProviderError('aborted', 'Provider request cancelled');
      if (error instanceof ProviderError) throw error;
      // No cause/raw response/URL is retained: upstream failures can echo secrets.
      throw new ProviderError('transport', 'Provider transport failed');
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', abort);
    }
  }

  async models(signal?: AbortSignal): Promise<string[]> {
    return this.#request('/models', { method: 'GET' }, signal, async response => {
      const body = await readJSON(response);
      if (!record(body) || body.error != null || !Array.isArray(body.data) || body.data.length > 10_000) throw malformed();
      const ids: string[] = [];
      for (const model of body.data) {
        if (!record(model) || typeof model.id !== 'string' || !model.id.trim() || model.id.length > 1_024) throw malformed();
        ids.push(model.id);
      }
      return [...new Set(ids)];
    });
  }

  async complete(input: Parameters<ModelProvider['complete']>[0]): Promise<CompletionResult> {
    if (!input.model.trim() || (input.maxTokens !== undefined && (!Number.isSafeInteger(input.maxTokens) || input.maxTokens <= 0))) {
      throw new ProviderError('configuration', 'A model and positive integer token limit are required');
    }
    const body = JSON.stringify({ model: input.model, messages: input.messages, stream: this.#streaming, ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}) });
    return this.#request('/chat/completions', { method: 'POST', body }, input.signal, async response => {
      if (!this.#streaming) {
        const payload = await readJSON(response);
        if (!record(payload) || payload.error != null || !Array.isArray(payload.choices) || payload.choices.length !== 1) throw malformed();
        const choice = payload.choices[0];
        if (!record(choice) || !record(choice.message)) throw malformed();
        rejectRefusal(choice.message.refusal);
        rejectNativeTools(choice.message);
        checkFinish(choice.finish_reason);
        if (typeof choice.message.content !== 'string' || !choice.message.content.trim()) throw malformed();
        const usage = usageFrom(payload.usage);
        input.onDelta?.(choice.message.content);
        return { text: choice.message.content, usage, finishReason: choice.finish_reason };
      }
      if (!(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'text/event-stream')) {
        await response.body?.cancel().catch(() => undefined);
        throw malformed();
      }
      if (!response.body) throw malformed();
      let text = '', finishReason: string | undefined, usage: ModelUsage | undefined;
      for await (const frame of frames(response.body)) {
        if (frame.event === 'error') throw new ProviderError('transport', 'Provider reported a stream error');
        if (frame.data === '[DONE]') {
          checkFinish(finishReason);
          if (!text.trim()) throw malformed();
          return { text, usage, finishReason };
        }
        const payload = parseJSON(frame.data);
        if (!record(payload)) throw malformed();
        if (payload.error != null) throw new ProviderError('transport', 'Provider reported a stream error');
        if (payload.usage != null) usage = usageFrom(payload.usage);
        if (!Array.isArray(payload.choices) || payload.choices.length > 1) throw malformed();
        if (payload.choices.length === 0) {
          if (payload.usage == null) throw malformed();
          continue;
        }
        const choice = payload.choices[0];
        if (!record(choice) || choice.index !== 0 || !record(choice.delta)) throw malformed();
        rejectRefusal(choice.delta.refusal);
        rejectNativeTools(choice.delta);
        const content = choice.delta.content;
        if (content != null && typeof content !== 'string') throw malformed();
        if (finishReason !== undefined) throw malformed();
        if (typeof content === 'string' && content) {
          text += content;
          input.onDelta?.(content); // Provisional display only; never action execution.
        }
        if (choice.finish_reason != null) {
          checkFinish(choice.finish_reason);
          finishReason = choice.finish_reason;
        }
      }
      throw truncated();
    });
  }
}
