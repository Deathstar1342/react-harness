import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparePrompts, variants, task } from './stark-prompt-probe.mjs';
import { protocolInstructions } from '../server/protocol.ts';
const env = { STARK_BASE_URL: 'https://private.example/v1', STARK_API_KEY: 'private-test-key' };
const valid = JSON.stringify({ version: 1, type: 'action', message: 'Read first', action: { name: 'read_file', args: { path: 'README.md' } } });
test('same task across variants, real role prompt and synthetic guidance, no project reads', async () => {
  for (const role of ['architect','coder','critic']) {
    const cases = await variants(role);
    assert.equal(cases.length, 3);
    assert.ok(cases.every(c => c.messages.at(-1).content === task));
    assert.equal(cases[1].messages[0].content, protocolInstructions(role));
    assert.match(cases[2].messages[2].content, /"status":"absent"/);
  }
});
test('all roles compare fresh prompts with fixed token budget and no execution, checkpoints redact secrets', async () => {
  const requests = [], saved = [];
  const result = await comparePrompts({ env: { ...env, ARCHITECT_PROMPT_FILE: '/private/unused.txt' }, provider: { complete: async input => { requests.push(input); return { text: valid, finishReason: 'stop' }; } }, checkpoint: report => saved.push(report), log() {} });
  assert.equal(requests.length, 9);
  assert.ok(requests.every(r => r.maxTokens === 16384));
  assert.ok(result.attempts.every(a => a.formatValid && a.requestedRead));
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.localPromptExtensionsConfiguredButExcluded, ['architect']);
  assert.ok(!JSON.stringify(result).includes('/private/unused.txt'));
  assert.ok(saved.some(r => r.attempts.some(a => a.state === 'pending')));
});
test('one format repair per variant; reports prose, redacts output and does not call it a valid action', async () => {
  const requests = [];
  const result = await comparePrompts({ env, selectedRoles: ['coder'], provider: { complete: async input => { requests.push(input); return { text: `prose ${env.STARK_API_KEY} ${env.STARK_BASE_URL}`, finishReason: 'stop' }; } }, log() {} });
  assert.equal(requests.length, 6);
  assert.equal(requests[1].messages.at(-2).role, 'assistant');
  assert.ok(result.attempts.every(a => !a.formatValid && !a.requestedRead));
  assert.ok(!JSON.stringify(result).includes(env.STARK_API_KEY));
  assert.ok(!JSON.stringify(result).includes('private.example'));
});
test('valid final is format success but not task success, and is not retried', async () => {
  const result = await comparePrompts({ env, selectedRoles: ['critic'], provider: { complete: async () => ({ text: '{"version":1,"type":"final","message":"Done"}', finishReason: 'stop' }) }, log() {} });
  assert.equal(result.attempts.length, 3);
  assert.ok(result.attempts.every(a => a.formatValid && !a.requestedRead));
});
test('provider failures stop safely without echoing raw errors', async () => {
  let calls = 0;
  const result = await comparePrompts({ env, provider: { complete: async () => { calls++; throw Object.assign(new Error(env.STARK_API_KEY), { code: 'http', status: 401 }); } }, log() {} });
  assert.equal(calls, 1); assert.equal(result.status, 'stopped-on-provider-error');
  assert.equal(result.attempts[0].httpStatus, 401);
  assert.ok(!JSON.stringify(result).includes(env.STARK_API_KEY));
});
