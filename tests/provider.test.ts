import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { setImmediate as tick } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StarkProvider, ProviderError } from '../server/provider.js';
import { parseAgentResponse } from '../server/protocol.js';

const servers: http.Server[] = [];
const key = 'private-test-key-NEVER-ECHO';
const input = { model: 'test-model', messages: [{ role: 'user' as const, content: 'Hello' }] };
async function fake(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<string> {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => { if (!res.destroyed) { res.statusCode = 500; res.end(); } });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  return `http://127.0.0.1:${address.port}/v1`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  vi.restoreAllMocks();
});
async function requestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const frame = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const finished = (text: string) => `${frame({ content: text })}${frame({}, 'stop')}data: [DONE]\n\n`;
const stream = (res: ServerResponse, text: string) => { res.setHeader('Content-Type', 'text/event-stream'); res.end(text); };
const json = (res: ServerResponse, value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
const response = (content: unknown = 'hello', finish = 'stop') => ({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }], usage: { prompt_tokens: 12, completion_tokens: 3 } });

describe('StarkProvider ordinary HTTP completions', () => {
  it('discovers models, authenticates server-side, deduplicates IDs, and keeps secrets private', async () => {
    let url: string | undefined, authorization: string | undefined;
    const baseUrl = await fake((req, res) => { url = req.url; authorization = req.headers.authorization; json(res, { data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] }); });
    const provider = new StarkProvider({ baseUrl: `${baseUrl}/`, apiKey: key });
    expect(await provider.models()).toEqual(['a', 'b']);
    expect(url).toBe('/v1/models');
    expect(authorization).toBe(`Bearer ${key}`);
    expect(JSON.stringify(provider)).not.toContain(key);
  });
  it('sends ordinary chat text without tools/response_format and supports nonstreaming usage', async () => {
    let body: Record<string, unknown> = {}, url: string | undefined;
    const baseUrl = await fake(async (req, res) => { url = req.url; body = await requestBody(req); json(res, response()); });
    const onDelta = vi.fn();
    const result = await new StarkProvider({ baseUrl, apiKey: key, streaming: false }).complete({ ...input, maxTokens: 222, onDelta });
    expect(body).toEqual({ ...input, max_tokens: 222, stream: false });
    expect(url).toBe('/v1/chat/completions');
    expect(result).toEqual({ text: 'hello', usage: { inputTokens: 12, outputTokens: 3 }, finishReason: 'stop' });
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('hello');
  });
  it('parses byte-chunked CRLF, UTF-8, comments, multiline data and usage frames', async () => {
    let body: Record<string, unknown> = {};
    const baseUrl = await fake(async (req, res) => {
      body = await requestBody(req);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      const wire = ': heartbeat\r\n\r\n' +
        'event: message\r\nid: 1\r\ndata: {"choices":\r\ndata: [{"index":0,"delta":{"role":"assistant","content":"hé🌍"},"finish_reason":null}]}\r\n\r\n' +
        frame({ content: ' there' }).replaceAll('\n', '\r\n') + frame({}, 'stop').replaceAll('\n', '\r\n') +
        'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":4}}\r\n\r\ndata: [DONE]\r\n\r\n';
      const buffer = Buffer.from(wire);
      for (let i = 0; i < buffer.length; i++) { res.write(buffer.subarray(i, i + 1)); await tick(); }
      res.end();
    });
    const deltas: string[] = [];
    const result = await new StarkProvider({ baseUrl, apiKey: key }).complete({ ...input, onDelta: text => deltas.push(text) });
    expect(result).toEqual({ text: 'hé🌍 there', finishReason: 'stop', usage: { inputTokens: 7, outputTokens: 4 } });
    expect(deltas).toEqual(['hé🌍', ' there']);
    expect(body).toEqual({ ...input, stream: true });
  });
  it('supports CR-only line endings and finish content in the same frame', async () => {
    const baseUrl = await fake((_req, res) => stream(res, (frame({ content: 'ok' }, 'stop') + 'data: [DONE]\n\n').replaceAll('\n', '\r')));
    expect((await new StarkProvider({ baseUrl, apiKey: key }).complete(input)).text).toBe('ok');
  });
  it.each([
    ['truncated', frame({ content: 'partial' })],
    ['truncated', frame({ content: 'complete' }, 'stop')],
    ['truncated', frame({ content: 'complete' }, 'stop') + 'data: [DONE]'],
    ['truncated', frame({ content: 'complete' }) + 'data: [DONE]\n\n'],
    ['truncated', frame({ content: 'partial' }, 'length')],
    ['refusal', frame({ refusal: 'private upstream reason' }, 'stop')],
    ['refusal', frame({}, 'content_filter')],
    ['malformed', 'data: {incomplete\n\n'],
    ['malformed', frame({ tool_calls: [{ function: { name: 'x' } }] }, 'tool_calls')],
    ['malformed', frame({ content: ['not text'] }, 'stop')],
    ['malformed', 'data: {"choices":[{"index":1,"delta":{"content":"bad"}}]}\n\n'],
    ['malformed', frame({ content: 'ok' }, 'stop') + frame({ content: 'late content' })],
    ['malformed', frame({}, 'stop') + 'data: [DONE]\n\n'],
    ['transport', `event: error\ndata: ${key}\n\n`],
    ['transport', `data: {"error":{"message":"${key}"}}\n\n`],
  ])('rejects %s stream safely %#', async (code, wire) => {
    const baseUrl = await fake((_req, res) => stream(res, wire));
    const promise = new StarkProvider({ baseUrl, apiKey: key }).complete(input);
    await expect(promise).rejects.toMatchObject({ name: 'ProviderError', code, message: expect.not.stringContaining(key) });
  });
  it('never promotes streamed complete JSON to an executable action after truncated transport', async () => {
    const text = JSON.stringify({ version: 1, type: 'action', message: 'write', action: { name: 'write_file', args: { path: 'a', content: 'x', baseHash: null } } });
    const baseUrl = await fake((_req, res) => stream(res, frame({ content: text }, 'stop')));
    const execute = vi.fn(), onDelta = vi.fn();
    await expect(new StarkProvider({ baseUrl, apiKey: key }).complete({ ...input, onDelta }).then(result => execute(parseAgentResponse(result.text)))).rejects.toMatchObject({ code: 'truncated' });
    expect(onDelta).toHaveBeenCalledWith(text);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    ['truncated', response('partial', 'length')], ['refusal', response(null, 'content_filter')],
    ['refusal', { choices: [{ message: { refusal: key }, finish_reason: 'stop' }] }],
    ['malformed', response(['bad'])], ['malformed', { choices: [], error: key }],
    ['malformed', { ...response(), usage: { prompt_tokens: -1, completion_tokens: 2 } }],
  ])('rejects %s nonstreaming response %#', async (code, value) => {
    const baseUrl = await fake((_req, res) => json(res, value));
    await expect(new StarkProvider({ baseUrl, apiKey: key, streaming: false }).complete(input)).rejects.toMatchObject({ code });
  });
  it('retries only transient HTTP responses with a fixed attempt bound', async () => {
    let requests = 0;
    const baseUrl = await fake((_req, res) => { requests++; res.statusCode = 429; res.setHeader('Retry-After', '0'); res.end(key); });
    await expect(new StarkProvider({ baseUrl, apiKey: key }).complete(input)).rejects.toMatchObject({ code: 'http', status: 429, message: 'Provider HTTP request failed (429)' });
    expect(requests).toBe(3);
  });
  it('succeeds after a transient error and respects a long Retry-After without retrying early', async () => {
    let requests = 0;
    const baseUrl = await fake((_req, res) => { requests++; if (requests === 1) { res.statusCode = 503; res.setHeader('Retry-After', '0'); res.end(); } else stream(res, finished('recovered')); });
    expect((await new StarkProvider({ baseUrl, apiKey: key }).complete(input)).text).toBe('recovered');
    expect(requests).toBe(2);
    let longRequests = 0;
    const longUrl = await fake((_req, res) => { longRequests++; res.statusCode = 429; res.setHeader('Retry-After', '3600'); res.end(); });
    await expect(new StarkProvider({ baseUrl: longUrl, apiKey: key, timeoutMs: 100 }).complete(input)).rejects.toMatchObject({ code: 'http', status: 429 });
    expect(longRequests).toBe(1);
  });
  it.each([400, 401, 403, 404, 500])('does not retry HTTP %s or expose upstream response text', async status => {
    let requests = 0;
    const baseUrl = await fake((_req, res) => { requests++; res.statusCode = status; res.end(`${key} private prompt and file content`); });
    await expect(new StarkProvider({ baseUrl, apiKey: key }).models()).rejects.toMatchObject({ code: 'http', status, message: `Provider HTTP request failed (${status})` });
    expect(requests).toBe(1);
  });
  it('does not follow redirects carrying authorization to another service', async () => {
    let destinationRequests = 0;
    const destination = await fake((_req, res) => { destinationRequests++; json(res, { data: [] }); });
    const baseUrl = await fake((_req, res) => { res.statusCode = 307; res.setHeader('Location', destination); res.end(); });
    await expect(new StarkProvider({ baseUrl, apiKey: key }).models()).rejects.toMatchObject({ code: 'transport' });
    expect(destinationRequests).toBe(0);
  });
  it('cancels before sending and sanitizes caller abort reasons', async () => {
    let requests = 0;
    const baseUrl = await fake((_req, res) => { requests++; stream(res, finished('x')); });
    const controller = new AbortController(); controller.abort(new Error(key));
    await expect(new StarkProvider({ baseUrl, apiKey: key }).complete({ ...input, signal: controller.signal })).rejects.toMatchObject({ code: 'aborted', message: 'Provider request cancelled' });
    expect(requests).toBe(0);
  });
  it('cancels during streaming without replay and removes the external listener', async () => {
    let requests = 0;
    const baseUrl = await fake((_req, res) => { requests++; res.setHeader('Content-Type', 'text/event-stream'); res.write(frame({ content: 'incomplete' })); });
    const controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(new StarkProvider({ baseUrl, apiKey: key }).complete({ ...input, signal: controller.signal, onDelta: () => controller.abort(key) })).rejects.toMatchObject({ code: 'aborted' });
    expect(requests).toBe(1);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
  it.each([true, false])('honors cancellation from the last delta (streaming=%s)', async streaming => {
    const baseUrl = await fake((_req, res) => { if (streaming) stream(res, finished('done')); else json(res, response('done')); });
    const controller = new AbortController();
    await expect(new StarkProvider({ baseUrl, apiKey: key, streaming }).complete({ ...input, signal: controller.signal, onDelta: () => controller.abort() })).rejects.toMatchObject({ code: 'aborted' });
  });
  it('rejects a socket failure after output without retrying or exposing raw transport errors', async () => {
    let requests = 0;
    const baseUrl = await fake(async (_req, res) => {
      requests++; res.setHeader('Content-Type', 'text/event-stream'); res.write(frame({ content: 'partial' }));
      await new Promise(resolve => setTimeout(resolve, 20));
      res.destroy(new Error(key));
    });
    const onDelta = vi.fn();
    await expect(new StarkProvider({ baseUrl, apiKey: key }).complete({ ...input, onDelta })).rejects.toMatchObject({ code: 'transport', message: 'Provider transport failed' });
    expect(requests).toBe(1);
    expect(onDelta).toHaveBeenCalledWith('partial');
  });
  it('cancels retry backoff promptly', async () => {
    let requests = 0;
    const controller = new AbortController();
    const baseUrl = await fake((_req, res) => { requests++; res.statusCode = 429; res.setHeader('Retry-After', '5'); res.end(); });
    const promise = new StarkProvider({ baseUrl, apiKey: key }).complete({ ...input, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 40);
    try { await expect(promise).rejects.toMatchObject({ code: 'aborted' }); } finally { clearTimeout(timer); }
    expect(requests).toBe(1);
  });
  it.each([false, true])('times out stalled headers or body (body=%s)', async withBody => {
    const baseUrl = await fake((_req, res) => { if (withBody) { res.setHeader('Content-Type', 'text/event-stream'); res.write(frame({ content: 'waiting' })); } });
    await expect(new StarkProvider({ baseUrl, apiKey: key, timeoutMs: 50 }).complete(input)).rejects.toMatchObject({ code: 'timeout' });
  });
  it('cleans timeout and abort listener after success', async () => {
    const baseUrl = await fake((_req, res) => stream(res, finished('ok')));
    const controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    await new StarkProvider({ baseUrl, apiKey: key }).complete({ ...input, signal: controller.signal });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(clear).toHaveBeenCalled();
  });
  it('rejects unexpected content types and oversized events', async () => {
    const baseUrl = await fake((_req, res) => json(res, response()));
    await expect(new StarkProvider({ baseUrl, apiKey: key }).complete(input)).rejects.toMatchObject({ code: 'malformed' });
    const hugeUrl = await fake((_req, res) => stream(res, 'data: ' + 'x'.repeat(1024 * 1024 + 1)));
    await expect(new StarkProvider({ baseUrl: hugeUrl, apiKey: key }).complete(input)).rejects.toMatchObject({ code: 'limit' });
  });
  it('bounds nonstreaming responses and validates model discovery', async () => {
    const hugeUrl = await fake((_req, res) => json(res, response('x'.repeat(4 * 1024 * 1024))));
    await expect(new StarkProvider({ baseUrl: hugeUrl, apiKey: key, streaming: false }).complete(input)).rejects.toMatchObject({ code: 'limit' });
    const badUrl = await fake((_req, res) => json(res, { data: [{ id: 123 }] }));
    await expect(new StarkProvider({ baseUrl: badUrl, apiKey: key }).models()).rejects.toMatchObject({ code: 'malformed' });
  });
  it('fails missing/unsafe configuration without exposing it', async () => {
    for (const baseUrl of ['', 'file:///private', `https://user:${key}@example.com/v1`, `https://example.com/v1?token=${key}`]) {
      await expect(new StarkProvider({ baseUrl, apiKey: key }).models()).rejects.toMatchObject({ code: 'configuration', message: expect.not.stringContaining(key) });
    }
    expect(() => new StarkProvider({ baseUrl: '', apiKey: '', timeoutMs: 0 })).toThrow(ProviderError);
  });
});
