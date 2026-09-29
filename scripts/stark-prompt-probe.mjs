// Run with Node 24: node --env-file=.env --import tsx scripts/stark-prompt-probe.mjs
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readConfig } from '../server/config.ts';
import { StarkProvider } from '../server/provider.ts';
import { protocolInstructions, parseAgentResponse } from '../server/protocol.ts';
import { projectInstructionsPolicy, readProjectInstructions } from '../server/project-instructions.ts';

export const roles = ['architect', 'coder', 'critic'];
export const task = 'Inspect README.md before deciding what to do next. Its contents have not been provided. Your next response should request reading that file; do not invent its contents or claim it was read.';
const repair = 'The response did not match the required JSON schema. Return one complete valid response with supported action arguments. Nothing was executed.';

export async function variants(role) {
  if (!roles.includes(role)) throw new Error('Unknown role');
  const system = protocolInstructions(role); // Actual checked-out application prompt, without local extensions.
  const guidance = await readProjectInstructions({ read: async (_root, path) => ({ path, content: '', hash: null }) }, '/synthetic/workspace');
  // Matches Runtime.loop state assembly, but never reads a real project/history.
  const authoritative = `Project: /synthetic/workspace\nPlan: {"phases":[]}\nMode: Implementation is allowed subject to the runtime approval policy.\nYou are the ${role}. ${role === 'architect' ? 'You own the user conversation. Delegate code changes to a coder. Inspect context as needed. Report critic findings honestly.' : role === 'critic' ? 'Review independently against the original request, task acceptance criteria, actual files, git diff, and tool/test evidence. Only read tools are permitted. Conclude with review_result. Do not infer tests passed from model claims.' : 'Complete the assigned task, read before editing, preserve manual changes, verify results, and provide evidence. Never delegate recursively.'}`;
  return [
    { name: 'minimal', messages: [{ role: 'user', content: 'Reply with one JSON object, no prose or Markdown. For a read request use version 1, type "action", a brief message, and action {name:"read_file",args:{path:string}}.' }, { role: 'user', content: task }] },
    { name: 'role-protocol', messages: [{ role: 'system', content: system }, { role: 'user', content: task }] },
    { name: 'full-synthetic', messages: [{ role: 'system', content: `${system}\n\n${projectInstructionsPolicy}` }, { role: 'user', content: `Authoritative task state:\n${authoritative}` }, guidance.message, { role: 'user', content: task }] },
  ];
}

export async function comparePrompts({ env = process.env, selectedRoles = roles, provider, checkpoint = () => {}, log = console.log } = {}) {
  if (!selectedRoles.length || selectedRoles.some(role => !roles.includes(role))) throw new Error('Unknown role');
  const config = readConfig(env);
  if (!config.baseUrl || !config.apiKey.trim()) throw new Error('Missing STARK configuration');
  const client = provider ?? new StarkProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey, streaming: false, maxRetries: 0, timeoutMs: 120000 });
  const redact = text => text.split(config.apiKey).join('[REDACTED_KEY]').split(config.baseUrl).join('[REDACTED_URL]').replace(/https?:\/\/[^\s"<>]+/g, '[REDACTED_URL]');
  const report = {
    version: 1, createdAt: new Date().toISOString(), streaming: false, maxTokens: config.maxOutputTokens,
    task, status: 'running', variants: [], attempts: [],
    limits: 'Synthetic fresh task only. No real files, history, local prompt extensions, compaction or tool execution. Format validity is separate from the requested read action. Up to one formatting retry per variant, matching runtime. Direct diagnostic requests bypass the running app scheduler.',
    localPromptExtensionsConfiguredButExcluded: roles.filter(role => Boolean(config.promptFiles[role])),
  };
  const save = () => checkpoint(JSON.parse(redact(JSON.stringify(report))));
  save();
  for (const role of selectedRoles) {
    for (const variant of await variants(role)) {
      let messages = variant.messages;
      report.variants.push({ role, name: variant.name, model: config.models[role], messages, promptSha256: createHash('sha256').update(JSON.stringify(messages)).digest('hex') });
      for (let attempt = 1; attempt <= 2; attempt++) {
        const row = { role, variant: variant.name, attempt, state: 'pending' };
        report.attempts.push(row); save();
        log(`${role} / ${variant.name} / attempt ${attempt}: waiting (up to 120 seconds)...`);
        const start = Date.now();
        let result;
        try {
          result = await client.complete({ model: config.models[role], messages, maxTokens: config.maxOutputTokens });
        } catch (error) {
          Object.assign(row, { state: 'provider-error', elapsedMs: Date.now() - start, errorCode: ['http','transport','aborted','timeout','malformed','truncated','refusal','limit','configuration'].includes(error?.code) ? error.code : 'unknown', httpStatus: Number.isInteger(error?.status) ? error.status : null });
          report.status = 'stopped-on-provider-error'; save();
          return JSON.parse(redact(JSON.stringify(report)));
        }
        Object.assign(row, { state: 'complete', elapsedMs: Date.now() - start, content: result.text.slice(0, 64000), contentClipped: result.text.length > 64000, finishReason: result.finishReason ?? null, formatValid: false, requestedRead: false });
        // Redact before clipping too, so a secret spanning the clip boundary is not partially retained.
        row.content = redact(result.text).slice(0, 64000);
        try {
          const parsed = parseAgentResponse(result.text);
          row.formatValid = true;
          row.responseType = parsed.type;
          row.actionName = parsed.action?.name ?? null;
          row.requestedRead = parsed.type === 'action' && parsed.action.name === 'read_file' && parsed.action.args.path === 'README.md';
        } catch (error) { row.protocolError = ['size','json','schema'].includes(error?.code) ? error.code : 'unknown'; }
        save();
        log(`  JSON ${row.formatValid ? 'valid' : 'invalid'}; README read ${row.requestedRead ? 'requested' : 'not requested'}.`);
        if (row.formatValid) break;
        messages = [...messages, { role: 'assistant', content: result.text.slice(0, 64000) }, { role: 'user', content: repair }];
      }
    }
  }
  report.status = 'complete'; save();
  return JSON.parse(redact(JSON.stringify(report)));
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--help') { console.log('node --env-file=.env --import tsx scripts/stark-prompt-probe.mjs [all|architect|coder|critic]'); return; }
  if (args.length > 1 || (args[0] && args[0] !== 'all' && !roles.includes(args[0]))) throw new Error('Invalid role');
  mkdirSync('.harness', { recursive: true });
  const file = '.harness/stark-prompt-comparison.json';
  await comparePrompts({ selectedRoles: !args[0] || args[0] === 'all' ? roles : [args[0]], checkpoint: report => writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }) });
  console.log(`Saved ${file}. Review and attach this report, not .env. A pending attempt means the probe was interrupted.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(() => { console.error('Probe could not run/save. Check .env, Node 24+, installed app dependencies, role and folder permissions. Raw error omitted.'); process.exitCode = 1; });
}
