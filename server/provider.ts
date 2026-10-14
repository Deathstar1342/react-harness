import { parseNativeJSON } from './native-json.js';
import type { CompletionResult, ModelProvider, ModelUsage, NativeToolCall, ModelCatalogEntry } from '../shared/types.js';

type ErrorCode = 'configuration' | 'http' | 'transport' | 'aborted' | 'timeout' | 'malformed' | 'truncated' | 'refusal' | 'limit';
export class ProviderError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}
export interface StarkProviderOptions { baseUrl: string; apiKey: string; streaming?: boolean; timeoutMs?: number; maxRetries?: number }

/** Capture once per invocation, including any internal retries. Old keys live only
 * as long as their request. Errors never expose raw upstream text or credentials. */
export class ReloadingProvider implements ModelProvider {
  constructor(private options: () => StarkProviderOptions) {}
  catalog(signal?: AbortSignal): Promise<ModelCatalogEntry[]> { return new StarkProvider({...this.options()}).catalog(signal); }
  models(signal?: AbortSignal): Promise<string[]> { return new StarkProvider({...this.options()}).models(signal); }
  complete(input: Parameters<ModelProvider['complete']>[0]): Promise<CompletionResult> {
    return new StarkProvider({...this.options()}).complete(input);
  }
}
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FRAME_CHARACTERS = 1024 * 1024;
const MAX_RETRIES = 2;
const malformed = () => new ProviderError('malformed', 'Provider returned an invalid completion payload');
const truncated = () => new ProviderError('truncated', 'Provider completion was truncated or did not finish normally');
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function parseJSON(text: string): unknown {
  try { return parseNativeJSON(text,MAX_BYTES); } catch { throw malformed(); }
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
export const NATIVE_LIMITS = Object.freeze({calls:16,id:200,name:64,arguments:1_100_000});
function checkFinish(reason: unknown, calls: number): asserts reason is 'stop' | 'tool_calls' {
  if (reason === 'content_filter') throw new ProviderError('refusal', 'Provider refused the completion');
  if (reason === 'length' || reason == null) throw truncated();
  if (reason !== (calls ? 'tool_calls' : 'stop')) throw malformed();
}
export function validateNativeCalls(value: unknown): NativeToolCall[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.length || value.length > NATIVE_LIMITS.calls) throw malformed();
  const ids = new Set<string>();
  return value.map(call => {
    if (!record(call) || call.type !== 'function' || typeof call.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(call.id) || ids.has(call.id) || !record(call.function)) throw malformed();
    const {name,arguments:args} = call.function;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name) || typeof args !== 'string' || Buffer.byteLength(args) > NATIVE_LIMITS.arguments) throw malformed();
    ids.add(call.id);
    return {id:call.id,type:'function',function:{name,arguments:args}};
  });
}
export function validateNativeHistory(messages: Parameters<ModelProvider['complete']>[0]['messages']): void {
  let pending = new Set<string>(); const used = new Set<string>();
  for (const message of messages) {
    if (typeof message.content !== 'string') throw malformed();
    if (message.role === 'tool') {
      if (!pending.delete(message.tool_call_id)) throw malformed();
    } else {
      if (pending.size) throw malformed();
      if (message.role === 'assistant') for (const call of validateNativeCalls(message.tool_calls)) {
        if (used.has(call.id)) throw malformed(); used.add(call.id); pending.add(call.id);
      }
    }
  }
  if (pending.size) throw malformed();
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

  async #request<T>(endpoint: string, init: RequestInit, external: AbortSignal | undefined, consume: (response: Response) => Promise<T>, noRetry = false): Promise<T> {
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
          headers: { 'Authorization': `Bearer ${this.#apiKey}`, 'Accept': (init.headers as Record<string,string>|undefined)?.Accept ?? (endpoint === '/models' || !this.#streaming ? 'application/json' : 'text/event-stream'), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          const retryable = [429, 502, 503, 504].includes(response.status);
          if (retryable && !noRetry && attempt < this.#maxRetries) {
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

  async models(signal?: AbortSignal): Promise<string[]> { return (await this.catalog(signal)).map(m=>m.id); }
  async catalog(signal?: AbortSignal): Promise<ModelCatalogEntry[]> {
    return this.#request('/models', {method:'GET'}, signal, async response => {
      const body = await readJSON(response);
      if (!record(body) || body.error != null || !Array.isArray(body.data) || body.data.length > 10000) throw malformed();
      const entries = new Map<string,ModelCatalogEntry>();
      for (const model of body.data) {
        if (!record(model) || typeof model.id !== 'string' || !model.id.trim() || model.id.length > 1024) throw malformed();
        // Untrusted metadata is informational, never capability authority.
        const {id,...metadata} = model;
        if (Buffer.byteLength(JSON.stringify(metadata)) > 64000) throw malformed();
        if(id.includes(this.#apiKey))throw malformed();
        const safeMetadata=JSON.parse(JSON.stringify(metadata,(key,value)=>{
          if(key.includes(this.#apiKey))throw malformed();
          return typeof value==='string'?value.split(this.#apiKey).join('[redacted]'):value;
        }));
        entries.set(id,{id,metadata:safeMetadata,capabilities:{ordinary:'unknown',native:'unknown',streaming:'unknown'}});
      }
      return [...entries.values()];
    });
  }

  async complete(input: Parameters<ModelProvider['complete']>[0]): Promise<CompletionResult> {
    if (!input.model.trim() || (input.maxTokens !== undefined && (!Number.isSafeInteger(input.maxTokens) || input.maxTokens <= 0))) {
      throw new ProviderError('configuration', 'A model and positive integer token limit are required');
    }
    validateNativeHistory(input.messages);
    const streaming = input.streaming ?? this.#streaming;
    const body = JSON.stringify({ model: input.model, messages: input.messages, stream: streaming, ...(input.tools?.length ? {tools:input.tools,tool_choice:input.toolChoice ?? 'auto'} : {}), ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}) });
    return this.#request('/chat/completions', { method: 'POST', body,headers:{Accept:streaming?'text/event-stream':'application/json'} }, input.signal, async response => {
      const requestId = response.headers.get('x-request-id');
      const trace = requestId && /^[A-Za-z0-9_.:-]{1,200}$/.test(requestId) && !requestId.includes(this.#apiKey) ? {requestId} : {};
      if (!streaming) {
        const payload = await readJSON(response);
        if (!record(payload) || payload.error != null || !Array.isArray(payload.choices) || payload.choices.length !== 1) throw malformed();
        const choice = payload.choices[0];
        if (!record(choice) || !record(choice.message)) throw malformed();
        rejectRefusal(choice.message.refusal);
        if (choice.message.function_call != null || choice.message.role !== 'assistant') throw malformed();
        const toolCalls = validateNativeCalls(choice.message.tool_calls);
        checkFinish(choice.finish_reason, toolCalls.length);
        const text = choice.message.content ?? '';
        if (typeof text !== 'string' || !text.trim() && !toolCalls.length) throw malformed();
        const usage = usageFrom(payload.usage);
        if (text) input.onDelta?.(text);
        return { text, ...(toolCalls.length ? {toolCalls} : {}), usage, finishReason: choice.finish_reason, ...trace };
      }
      if (!(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'text/event-stream')) {
        await response.body?.cancel().catch(() => undefined);
        throw malformed();
      }
      if (!response.body) throw malformed();
      let text = '', finishReason: string | undefined, usage: ModelUsage | undefined;
      const fragments = new Map<number,{id:string;name:string;arguments:string}>();
      for await (const frame of frames(response.body)) {
        if (frame.event === 'error') throw new ProviderError('transport', 'Provider reported a stream error');
        if (frame.data === '[DONE]') {
          const ordered = [...fragments.entries()].sort((a,b)=>a[0]-b[0]);
          if (ordered.some(([index],position)=>index!==position)) throw malformed();
          const toolCalls = ordered.length ? validateNativeCalls(ordered.map(([,f])=>({id:f.id,type:'function',function:{name:f.name,arguments:f.arguments}}))) : [];
          checkFinish(finishReason,toolCalls.length);
          if (!text.trim() && !toolCalls.length) throw malformed();
          return { text, ...(toolCalls.length ? {toolCalls} : {}), usage, finishReason, ...trace };
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
        if (choice.delta.function_call != null || choice.delta.role != null && choice.delta.role !== 'assistant') throw malformed();
        if (choice.delta.tool_calls != null) {
          if (!Array.isArray(choice.delta.tool_calls) || choice.delta.tool_calls.length > NATIVE_LIMITS.calls) throw malformed();
          for (const delta of choice.delta.tool_calls) {
            if (!record(delta) || !Number.isSafeInteger(delta.index) || Number(delta.index)<0 || Number(delta.index)>=NATIVE_LIMITS.calls || delta.type != null && delta.type !== 'function') throw malformed();
            const index = Number(delta.index), prior = fragments.get(index) ?? {id:'',name:'',arguments:''};
            if (delta.id != null) {
              if (typeof delta.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(delta.id) || prior.id && prior.id !== delta.id || [...fragments.entries()].some(([i,f])=>i!==index && f.id === delta.id)) throw malformed();
              prior.id = delta.id;
            }
            if (delta.function != null) {
              if (!record(delta.function)) throw malformed();
              if (delta.function.name != null) {
                if (typeof delta.function.name !== 'string') throw malformed();
                prior.name += delta.function.name;
              }
              if (delta.function.arguments != null) {
                if (typeof delta.function.arguments !== 'string') throw malformed();
                prior.arguments += delta.function.arguments;
              }
            }
            if (prior.name.length > NATIVE_LIMITS.name || Buffer.byteLength(prior.arguments) > NATIVE_LIMITS.arguments) throw malformed();
            fragments.set(index,prior);
          }
        }
        const content = choice.delta.content;
        if (content != null && typeof content !== 'string') throw malformed();
        if (finishReason !== undefined) throw malformed();
        if (typeof content === 'string' && content) {
          text += content;
          input.onDelta?.(content); // Provisional display only; never action execution.
        }
        if (choice.finish_reason != null) {
          checkFinish(choice.finish_reason,fragments.size);
          finishReason = choice.finish_reason;
        }
      }
      throw truncated();
    }, input.noRetry === true);
  }
}
