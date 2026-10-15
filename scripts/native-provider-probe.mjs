// Node 24+, no npm dependencies. No application runtime, project or action dispatch.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseNativeJSON } from '../server/native-json.ts';

export const LIMITS = Object.freeze({ requests: 7, timeoutMs: 30000, totalMs: 210000, bytes: 262144, models: 1000, tokens: 256 });
const token = 'M27 harmless echo';
const tool = { type: 'function', function: { name: 'diagnostic_echo', description: 'Echo the fixed diagnostic value in memory.', parameters: { type: 'object', properties: { value: { type: 'string', enum: [token] } }, required: ['value'], additionalProperties: false } } };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
class Failure extends Error { constructor(status) { super(status); this.status = status; } }
const fail = status => { throw new Failure(status); };
const parse = text => { try { return parseNativeJSON(text, LIMITS.bytes); } catch { fail('malformed'); } };
const row = () => ({ status: 'not_run', responseIdMatch: 'unknown', argumentsValid: false, callIdValid: false, resultCorrelated: false, acknowledgement: false });
const headersOf = headers => {
  // Presence/zero flags only: even numeric account identifiers must not be copied.
  const zero = name => { const value = headers.get(name); return value !== null && /^0(?:\.0+)?$/.test(value); };
  return { retryAfterPresent: headers.has('retry-after'), requestsExhausted: zero('x-ratelimit-remaining-requests'), tokensExhausted: zero('x-ratelimit-remaining-tokens'), creditsExhausted: zero('x-credits-remaining') };
};
function errorCategory(status, body) {
  const code = record(body?.error) ? body.error.code : undefined;
  if (['insufficient_quota', 'insufficient_credits', 'credit_exhausted'].includes(code) || status === 402) return 'credit_gate';
  if (['key_locked', 'api_key_locked'].includes(code) || status === 423) return 'key_locked';
  if (['model_retired', 'model_deprecated'].includes(code) || status === 410) return 'retired';
  if (status === 401 || status === 403) return 'authentication_gate';
  if (status === 429) return 'rate_gate';
  if (status === 404 || status === 405 || status === 501 || ['unsupported_parameter','unsupported_model','tool_not_supported'].includes(code)) return 'unsupported';
  return 'http_failure';
}
async function read(response) {
  if (!response.body) fail('malformed');
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > LIMITS.bytes) fail('response_limit'); chunks.push(part.value); }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { fail('malformed'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function completed(message, finish) {
  if (!record(message) || message.role !== 'assistant' || message.function_call != null) fail('malformed');
  if (message.refusal || finish === 'content_filter') fail('refused');
  if (finish == null || finish === 'length') fail('truncated');
  const calls = message.tool_calls ?? [];
  if (!Array.isArray(calls) || calls.length > 1 || (message.content != null && typeof message.content !== 'string')) fail('malformed');
  if (finish !== (calls.length ? 'tool_calls' : 'stop')) fail('malformed');
  return { text: message.content ?? '', calls };
}
function completion(text, streaming, model) {
  let responseIdMatch = 'unknown';
  const identity = body => { if (body.model != null) { if (body.model !== model) fail('model_mismatch'); responseIdMatch = 'matched'; } };
  if (!streaming) {
    const body = parse(text);
    if (!record(body) || body.error != null || !Array.isArray(body.choices) || body.choices.length !== 1) fail('malformed');
    identity(body); return { ...completed(body.choices[0]?.message, body.choices[0]?.finish_reason), responseIdMatch };
  }
  let content = '', finish, done = false, call;
  // Network byte boundaries are assembled before SSE framing; aggregate bytes/time are bounded.
  for (const event of text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n')) {
    const lines = event.split('\n');
    if (lines.some(line => /^event:\s*error$/.test(line))) fail('transport_failure');
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    if (done) fail('malformed');
    if (data === '[DONE]') { done = true; continue; }
    const body = parse(data);
    if (body?.error != null) fail('transport_failure');
    if (!record(body) || !Array.isArray(body.choices) || body.choices.length > 1) fail('malformed');
    identity(body);
    if (!body.choices.length && record(body.usage)) continue;
    const choice = body.choices[0], delta = choice?.delta;
    if (!record(delta) || choice.index !== 0 || finish !== undefined || delta.function_call != null || delta.role != null && delta.role !== 'assistant') fail('malformed');
    if (delta.refusal) fail('refused');
    if (delta.content != null) { if (typeof delta.content !== 'string') fail('malformed'); content += delta.content; }
    if (delta.tool_calls != null) {
      if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length !== 1) fail('malformed');
      const next = delta.tool_calls[0];
      if (!record(next) || next.index !== 0 || next.type != null && next.type !== 'function') fail('malformed');
      call ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (next.id != null) { if (typeof next.id !== 'string' || call.id && call.id !== next.id) fail('malformed'); call.id = next.id; }
      if (next.function != null) {
        if (!record(next.function)) fail('malformed');
        for (const field of ['name','arguments']) if (next.function[field] != null) { if (typeof next.function[field] !== 'string') fail('malformed'); call.function[field] += next.function[field]; }
      }
    }
    if (choice.finish_reason != null) finish = choice.finish_reason;
  }
  if (!done) fail('truncated');
  return { ...completed({ role: 'assistant', content, tool_calls: call ? [call] : [] }, finish), responseIdMatch };
}

export async function runProbe(env, fetcher = fetch) {
  const base = env.STARK_BASE_URL?.replace(/\/+$/, ''), key = env.STARK_API_KEY, model = env.M27_MODEL;
  if (!base || !key?.trim() || !model?.trim() || model.length > 1024 || key.length > 8192) fail('configuration');
  let url; try { url = new URL(base); } catch { fail('configuration'); }
  if (url.protocol !== 'https:' && !(env.M27_SYNTHETIC === '1' && url.protocol === 'http:' && url.hostname === '127.0.0.1') || url.username || url.password || url.search || url.hash) fail('configuration');
  const report = { version: 1, evidence: env.M27_SYNTHETIC === '1' ? 'synthetic' : 'work_endpoint_probe', limits: LIMITS, requestCount: 0, catalog: { status: 'not_run', exactConfiguredIdPresent: false, capabilityMetadata: 'unknown' }, plain: row(), native: row(), streamingPlain: row(), streamingNative: row(), requests: [], halted: false };
  const total = AbortSignal.timeout(LIMITS.totalMs);
  async function request(body, streaming = false) {
    if (report.halted || total.aborted || report.requestCount >= LIMITS.requests) fail('budget_gate');
    report.requestCount++;
    const receipt = { httpStatus: 0, headers: {} }; report.requests.push(receipt);
    const signal = AbortSignal.any([total, AbortSignal.timeout(LIMITS.timeoutMs)]);
    try {
      const response = await fetcher(base + (body ? '/chat/completions' : '/models'), {
        method: body ? 'POST' : 'GET', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${key}`, Accept: streaming ? 'text/event-stream' : 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      receipt.httpStatus = response.status; receipt.headers = headersOf(response.headers);
      if (Object.values(receipt.headers).some(Boolean)) report.halted = true;
      const text = await read(response);
      if (!response.ok) {
        let body; try { body = parse(text); } catch { /* Error text is never evidence. */ }
        const category = errorCategory(response.status, body);
        if (['credit_gate','key_locked','authentication_gate','rate_gate'].includes(category)) report.halted = true;
        fail(category);
      }
      if (streaming && response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream') fail('malformed');
      return body ? completion(text, streaming, model) : parse(text);
    } catch (error) {
      if (error instanceof Failure) throw error;
      fail(signal.aborted ? 'timeout' : 'transport_failure');
    }
  }
  try {
    const catalog = await request();
    if (!record(catalog) || catalog.error != null || !Array.isArray(catalog.data) || catalog.data.length > LIMITS.models || catalog.data.some(item => !record(item) || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 1024)) fail('malformed');
    report.catalog.exactConfiguredIdPresent = catalog.data.some(item => item.id === model);
    report.catalog.status = report.catalog.exactConfiguredIdPresent ? 'verified' : 'missing_model';
    if (!report.catalog.exactConfiguredIdPresent) return report;
  } catch (error) { report.catalog.status = error instanceof Failure ? error.status : 'unknown'; return report; }
  const invoke = (messages, streaming, native = false) => request({ model, stream: streaming, max_tokens: LIMITS.tokens, messages, ...(native ? { tools: [tool], tool_choice: 'auto' } : {}) }, streaming);
  for (const [name, streaming, native] of [['plain',false,false],['native',false,true],['streamingPlain',true,false],['streamingNative',true,true]]) {
    const result = report[name];
    if (report.halted) { result.status = 'budget_gate'; continue; }
    try {
      const messages = [{ role: 'user', content: native ? `Call diagnostic_echo exactly once with value ${JSON.stringify(token)}. After its result, reply exactly ACK.` : 'Reply exactly OK.' }];
      const first = await invoke(messages, streaming, native);
      result.responseIdMatch = first.responseIdMatch;
      if (!native) { result.acknowledgement = first.text.trim() === 'OK' && first.calls.length === 0; result.status = result.acknowledgement ? 'verified' : 'unexpected_reply'; continue; }
      if (!first.calls.length) fail('missing_tool');
      const call = first.calls[0];
      result.callIdValid = record(call) && typeof call.id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(call.id);
      if (!result.callIdValid || call.type !== 'function' || !record(call.function) || call.function.name !== 'diagnostic_echo') fail('malformed');
      const args = parse(call.function.arguments);
      result.argumentsValid = record(args) && Object.keys(args).length === 1 && args.value === token;
      if (!result.argumentsValid) fail('invalid_arguments');
      // The only handler is this fixed literal. Never invoke a requested function or echo arbitrary output.
      messages.push({ role: 'assistant', content: '', tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ value: token }) });
      const second = await invoke(messages, streaming);
      result.responseIdMatch = first.responseIdMatch === 'matched' && second.responseIdMatch === 'matched' ? 'matched' : 'unknown';
      result.resultCorrelated = true;
      result.acknowledgement = second.text.trim() === 'ACK' && second.calls.length === 0;
      result.status = result.acknowledgement ? 'verified' : 'unexpected_reply';
    } catch (error) {
      result.status = error instanceof Failure ? error.status : 'unknown';
      if (result.status === 'model_mismatch') result.responseIdMatch = 'mismatch';
    }
  }
  return report;
}

async function main() {
  if (process.argv[2] === '--help') { console.log('Node 24+: node --env-file=/private/probe.env scripts/native-provider-probe.mjs\nRequired: STARK_BASE_URL (HTTPS), STARK_API_KEY, M27_MODEL (exact catalog ID). Prints only a sanitized report.'); return; }
  if (process.argv.length > 2) fail('configuration');
  const report = await runProbe(process.env); console.log(JSON.stringify(report, null, 2));
  if ([report.catalog,report.plain,report.native,report.streamingPlain,report.streamingNative].some(item => item.status !== 'verified')) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(() => { console.error('Diagnostic configuration or execution failed; private details omitted.'); process.exitCode = 1; });
