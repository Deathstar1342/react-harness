import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProbe } from './stark-probe.mjs';
const env = { STARK_BASE_URL: 'https://private.example/v1', STARK_API_KEY: 'private-test-secret' };
const response = (content, finish_reason = 'stop') => Response.json({ choices: [{ message: { content }, finish_reason }] });
test('bounded formatting retries, nonstream requests and redaction', async () => {
  const requests = [];
  const report = await runProbe(env, 'architect', async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    assert.equal(body.stream, false); assert.equal(body.tools, undefined); assert.equal(body.response_format, undefined);
    if (requests.length === 1) return response(`Prose ${env.STARK_API_KEY} ${env.STARK_BASE_URL}`);
    return response(body.messages.at(-1).content.split('\n').at(-1));
  }, () => {});
  assert.equal(requests.length, 3);
  assert.deepEqual(report.attempts.map(a => a.passed), [false, true, true]);
  assert.equal(requests[1].messages[1].role, 'assistant');
  assert.ok(!JSON.stringify(report).includes(env.STARK_API_KEY));
  assert.ok(!JSON.stringify(report).includes('private.example'));
});
test('prose bounded at six requests, HTTP errors stop without exposing bodies', async () => {
  const report = await runProbe(env, 'coder', async () => response('prose'), () => {});
  assert.equal(report.attempts.length, 6);
  let calls = 0;
  const failed = await runProbe(env, 'coder', async () => { calls++; return new Response('secret error', { status: 401 }); }, () => {});
  assert.equal(calls, 1); assert.equal(failed.attempts[0].httpStatus, 401);
  assert.ok(!JSON.stringify(failed).includes('secret error'));
});
test('valid-looking truncated JSON cannot pass', async () => {
  const report = await runProbe(env, 'critic', async (_url, init) => response(JSON.parse(init.body).messages[0].content.split('\n').at(-1), 'length'), () => {});
  assert.equal(report.attempts.length, 2);
  assert.ok(report.attempts.every(a => a.matchesExpectedJson && !a.passed));
});
