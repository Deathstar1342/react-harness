import { describe, expect, it } from 'vitest';
import { actionSchema, parseAgentResponse, PROTOCOL_LIMITS, ProtocolError, protocolInstructions } from '../server/protocol.js';

const action = (name: string, args: unknown) => ({ version: 1, type: 'action', message: 'Proposed action', action: { name, args } });
const cases: [string, Record<string, unknown>][] = [
  ['list_files', {}], ['read_file', { path: 'README.md' }], ['search', { query: 'hello', path: 'src' }],
  ['write_file', { path: 'empty.txt', content: '', baseHash: null }], ['write_file', { path: 'a', content: 'new', baseHash: 'fresh-hash' }],
  ['run_shell', { command: 'pwd', timeoutMs: 1 }], ['execute_python', { code: 'print(1)', timeoutMs: 600_000 }],
  ['git_status', {}], ['git_diff', { path: 'src/a.ts' }], ['run_tests', { command: 'pytest', reportPath: 'report.xml' }],
  ['set_plan', { phases: [{ id: 'phase', title: 'Implementation', steps: [{ id: 'step', title: 'Check', status: 'in_progress' }] }] }],
  ['delegate', { objective: 'Check implementation', acceptanceCriteria: ['Tests pass'], paths: ['src'] }],
  ['review', { focus: 'Evidence' }], ['ask_user', { question: 'Which option?' }],
  ['review_result', { verdict: 'pass', findings: [] }], ['review_result', { verdict: 'changes_requested', findings: ['Missing verification'] }],
];

describe('versioned strict action protocol', () => {
  it.each(cases)('accepts %s with documented arguments', (name, args) => {
    const response = action(name, args);
    expect(parseAgentResponse(JSON.stringify(response))).toEqual(response);
    expect(actionSchema.parse(response.action)).toEqual(response.action);
  });
  it.each(['message', 'final'])('accepts %s without action', type => {
    const response = { version: 1, type, message: 'Evidence is still pending.' };
    expect(parseAgentResponse(` \n${JSON.stringify(response)}\r\n`)).toEqual(response);
    expect(() => parseAgentResponse(JSON.stringify({ ...response, action: { name: 'git_status', args: {} } }))).toThrow(ProtocolError);
  });
  it('rejects every prefix of an otherwise executable action', () => {
    const complete = JSON.stringify(action('write_file', { path: 'a', content: 'do not execute early', baseHash: null }));
    for (let index = 0; index < complete.length; index++) expect(() => parseAgentResponse(complete.slice(0, index))).toThrow(ProtocolError);
    expect(parseAgentResponse(complete).type).toBe('action');
  });
  it.each([
    '', 'I refuse', '```json\n{}\n```', '{} {}', 'null', '[]',
    '{"version":1,"type":"final","message":"ok"} trailing',
  ])('rejects non-envelope output %s', value => { expect(() => parseAgentResponse(value)).toThrow(ProtocolError); });
  it.each([
    { version: 2, type: 'final', message: 'text' },
    { version: 1, type: 'action', message: 'missing action' },
    { version: 1, type: 'final', message: 3 },
    { version: 1, type: 'final', message: 'text', approved: true },
    action('unknown_action', {}), action('git_status', { command: 'rm' }),
    action('write_file', { path: 'a', content: 'x' }),
    action('write_file', { path: 'a', content: 'x', baseHash: '' }),
    action('write_file', { path: 'a', content: 'x', baseHash: 123 }),
    action('run_shell', { command: 'x', timeoutMs: '100' }),
    action('run_shell', { command: ' ', timeoutMs: 1 }),
    action('run_shell', { command: 'x', timeoutMs: 0 }),
    action('run_shell', { command: 'x', timeoutMs: 600_001 }),
    action('run_shell', { command: 'x', timeoutMs: 1.5 }),
    action('read_file', { path: 'a\0b' }), action('read_file', { path: '' }),
    action('delegate', { objective: 'task', acceptanceCriteria: [] }),
    action('review_result', { verdict: 'approved', findings: [] }),
    action('review_result', { verdict: 'pass', findings: 'all good' }),
    action('review_result', { verdict: 'pass', findings: [], approved: true }),
    action('set_plan', { phases: [{ id: 'p', title: 'p', steps: [{ id: 's', title: 's', status: 'passed' }] }] }),
    action('set_plan', { phases: [{ id: 'p', title: 'p', steps: [], extra: true }] }),
    action('set_plan', { phases: [{ id: 'p', title: 'p', steps: [] }, { id: 'p', title: 'other', steps: [] }] }),
    action('set_plan', { phases: [{ id: 'p', title: 'p', steps: [{ id: 's', title: 's', status: 'done' }, { id: 's', title: 'other', status: 'pending' }] }] }),
  ])('rejects invalid arguments/envelopes %#', value => { expect(() => parseAgentResponse(JSON.stringify(value))).toThrow(ProtocolError); });
  it.each(cases)('rejects unknown fields inside each %s args object', (name, args) => {
    expect(() => parseAgentResponse(JSON.stringify(action(name, { ...args, unrecognized: true })))).toThrow(ProtocolError);
  });
  it('bounds text and array sizes', () => {
    for (const value of [
      action('read_file', { path: 'a'.repeat(PROTOCOL_LIMITS.pathCharacters + 1) }),
      action('write_file', { path: 'a', content: 'x'.repeat(PROTOCOL_LIMITS.contentCharacters + 1), baseHash: null }),
      action('delegate', { objective: 'x', acceptanceCriteria: Array(101).fill('criterion') }),
      action('review_result', { verdict: 'pass', findings: Array(101).fill('finding') }),
      { version: 1, type: 'final', message: 'x'.repeat(PROTOCOL_LIMITS.messageCharacters + 1) },
    ]) expect(() => parseAgentResponse(JSON.stringify(value))).toThrow(ProtocolError);
    expect(() => parseAgentResponse('x'.repeat(PROTOCOL_LIMITS.responseCharacters + 1))).toThrow('size limit');
  });
  it('does not expose raw model-controlled values in validation errors', () => {
    expect(() => parseAgentResponse('{secret-value')).toThrow(expect.objectContaining({ message: expect.not.stringContaining('secret-value') }));
    expect(() => parseAgentResponse(JSON.stringify({ 'secret-value': true }))).toThrow(expect.objectContaining({ message: expect.not.stringContaining('secret-value') }));
  });
  it('provides role-specific truthful instructions and bounded optional guidance', () => {
    expect(protocolInstructions('architect')).toContain('Only the architect may delegate');
    expect(protocolInstructions('coder')).toContain('Do not delegate');
    expect(protocolInstructions('critic')).toContain('Conclude with a review_result action');
    expect(protocolInstructions('critic')).toContain('Never write files');
    expect(protocolInstructions('coder', 'Prefer small changes.')).toContain('Prefer small changes.');
    expect(() => protocolInstructions('coder', 'x'.repeat(32_001))).toThrow('size limit');
  });
});
