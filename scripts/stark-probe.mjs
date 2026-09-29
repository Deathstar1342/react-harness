// Node 24+, no npm dependencies, no app or generated-action execution.
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
const defaults = { architect: 'gemini-3.1-pro-preview', coder: 'gemini-3.8-flash', critic: 'gemini-3.6-flash' };
const cases = [
  { name: 'simple-json', expected: { version: 1, type: 'final', message: 'Connection OK' } },
  { name: 'action-json', expected: { version: 1, type: 'action', message: 'Read README.md', action: { name: 'read_file', args: { path: 'README.md' } } } },
];
async function readBounded(response) {
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 4 * 1024 * 1024) throw new Error();
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function runProbe(env, role = 'architect', fetcher = fetch, log = console.log) {
  if (!Object.hasOwn(defaults, role)) throw new Error('Choose architect, coder, or critic.');
  const base = env.STARK_BASE_URL?.replace(/\/+$/, ''), key = env.STARK_API_KEY;
  if (!base || !key?.trim()) throw new Error('Missing STARK configuration. Use --env-file=.env.');
  try {
    const url = new URL(base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { throw new Error('Invalid STARK_BASE_URL. Expected HTTP(S) API base URL without credentials/query/fragment.'); }
  const maxTokens = Number(env.MODEL_MAX_OUTPUT_TOKENS || 16384);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 65536) throw new Error('Probe output-token limit must be 1..65536.');
  const model = env[`${role.toUpperCase()}_MODEL`] || defaults[role];
  const redact = text => text.split(key).join('[REDACTED_KEY]').split(base).join('[REDACTED_URL]').replace(/https?:\/\/[^\s"<>]+/g, '[REDACTED_URL]');
  const clip = value => typeof value === 'string' ? redact(value).slice(0, 64000) : null;
  const report = { version: 1, createdAt: new Date().toISOString(), role, model: redact(model), streaming: false, maxTokens, attempts: [] };
  for (const test of cases) {
    const messages = [{ role: 'user', content: `Return exactly this JSON object, without Markdown or additional text:\n${JSON.stringify(test.expected)}` }];
    for (let attempt = 1; attempt <= 3; attempt++) {
      log(`${test.name}: attempt ${attempt}/3 (up to 120 seconds)...`);
      const start = Date.now(), entry = { test: test.name, attempt, expected: test.expected };
      report.attempts.push(entry); let body;
      try {
        const response = await fetcher(`${base}/chat/completions`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ model, stream: false, max_tokens: maxTokens, messages }),
        });
        entry.httpStatus = response.status;
        if (!response.ok) { await response.body?.cancel(); entry.error = 'HTTP failure; raw body omitted.'; return report; }
        body = await readBounded(response);
      } catch { entry.error = 'Timeout, transport failure, or invalid/oversized response. Raw errors omitted.'; return report; }
      finally { entry.elapsedMs = Date.now() - start; }
      const choice = body?.choices?.[0], content = choice?.message?.content;
      Object.assign(entry, {
        choiceCount: Array.isArray(body?.choices) ? body.choices.length : null,
        finishReason: clip(choice?.finish_reason), content: clip(content),
        contentType: content === null ? 'null' : Array.isArray(content) ? 'array' : typeof content,
        contentClipped: typeof content === 'string' && content.length > 64000,
        refusal: clip(choice?.message?.refusal), providerErrorPresent: body?.error != null,
        nativeToolsPresent: choice?.message?.tool_calls != null || choice?.message?.function_call != null,
        matchesExpectedJson: false,
      });
      if (typeof content === 'string') { try { entry.matchesExpectedJson = isDeepStrictEqual(JSON.parse(content), test.expected); } catch {} }
      entry.passed = entry.matchesExpectedJson && choice?.finish_reason === 'stop' && entry.choiceCount === 1 && !choice?.message?.refusal && !entry.nativeToolsPresent && !entry.providerErrorPresent;
      log(`  ${entry.passed ? 'PASS' : 'Not matched/usable'}; reply saved in report.`);
      if (entry.passed || typeof content !== 'string' || entry.contentClipped || choice?.finish_reason !== 'stop' || choice?.message?.refusal || entry.nativeToolsPresent || entry.providerErrorPresent || entry.choiceCount !== 1) break;
      messages.push({ role: 'assistant', content }, { role: 'user', content: `The response was not the requested JSON. Return exactly this object and nothing else:\n${JSON.stringify(test.expected)}` });
    }
  }
  return report;
}
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--help') { console.log('node --env-file=.env scripts/stark-probe.mjs [architect|coder|critic]'); return; }
  if (args.length > 1) throw new Error('Use at most one role: architect, coder, or critic.');
  const role = args[0] || 'architect';
  const report = await runProbe(process.env, role);
  mkdirSync('.harness', { recursive: true });
  const file = `.harness/stark-probe-${role}.json`;
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`Saved ${file}. Review and attach this file to the chat; do not upload .env.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(() => { console.error('Probe could not run/save. Check .env, Node 24+, role argument and folder permissions. No raw error printed.'); process.exitCode = 1; });
}
