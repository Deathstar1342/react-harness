import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorkspaceTools } from '../server/tools/index.js';
import { childEnvironment } from '../server/tools/shell.js';
import { parseJUnit, unavailableReport } from '../server/tools/junit.js';
import type { ToolContext } from '../shared/types.js';
let root: string, tools: WorkspaceTools, context: ToolContext;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'harness-tools-')); tools = new WorkspaceTools(); context = { projectRoot: root, chatId: 'chat', agentId: 'agent' }; });
afterEach(async () => { await tools.dispose(); await rm(root, { recursive: true, force: true }); });
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' }).toString();

describe('workspace file correctness', () => {
  it('returns versions, distinguishes a missing read, and rejects stale approved edits', async () => {
    expect(await tools.read(root, 'missing.txt')).toEqual({ path: 'missing.txt', content: '', hash: null });
    expect((await tools.execute(context, { name: 'read_file', args: { path: 'missing.txt' } })).ok).toBe(false);
    const first = await tools.save(root, 'a.txt', 'first\n', null);
    const action = { name: 'write_file', args: { path: 'a.txt', content: 'proposed\n', baseHash: first.hash } };
    const inspection = await tools.inspect(context, action);
    expect(inspection.diff).toContain('-first'); expect(inspection.diff).toContain('+proposed');
    await writeFile(path.join(root, 'a.txt'), 'manual\n');
    expect((await tools.execute(context, action)).ok).toBe(false);
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('manual\n');
    await expect(tools.inspect(context, action)).rejects.toThrow('stale');
  });
  it('serializes conflicting saves across service instances and distinguishes empty files from absent ones', async () => {
    const second = new WorkspaceTools();
    try {
      const outcomes = await Promise.allSettled([tools.save(root, 'new.txt', 'a', null), second.save(root, 'new.txt', 'b', null)]);
      expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter(r => r.status === 'rejected')).toHaveLength(1);
      const empty = await tools.save(root, 'empty.txt', '', null);
      expect(empty.hash).toMatch(/^[a-f0-9]{64}$/);
      await expect(tools.save(root, 'empty.txt', 'overwrite', null)).rejects.toThrow('changed');
    } finally { await second.dispose(); }
  });
  it('protects dirty leases, supports owning editor saves, and expires abandoned leases', async () => {
    tools = new WorkspaceTools({ leaseMs: 30 });
    const file = await tools.save(root, 'lease.txt', 'initial', null);
    tools.setDirty(root, 'lease.txt', 'editor', true);
    expect(() => tools.setDirty(root, 'lease.txt', 'other', false)).toThrow('owns');
    await expect(tools.save(root, 'lease.txt', 'agent', file.hash, 'agent')).rejects.toThrow('unsaved');
    const saved = await tools.save(root, 'lease.txt', 'manual', file.hash, 'editor');
    tools.setDirty(root, 'lease.txt', 'editor', true);
    await new Promise(resolve => setTimeout(resolve, 45));
    expect((await tools.save(root, 'lease.txt', 'after expiry', saved.hash, 'agent')).content).toBe('after expiry');
  });
  it.each(['../outside', 'dir/../../file', '..\\outside', '/etc/passwd', 'C:\\test', 'file:stream', '.git/config', 'nested/.env.local', '.ssh/id_rsa', 'key.pem', 'credentials.json', 'x/NUL', 'file.'])('rejects protected or ambiguous path %s', async input => {
    await expect(tools.read(root, input)).rejects.toThrow();
    await expect(tools.save(root, input, 'bad', null)).rejects.toThrow();
  });
  it('rejects directory junction traversal and hard links', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'harness-outside-'));
    try {
      await writeFile(path.join(outside, 'outside.txt'), 'external');
      await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      await expect(tools.read(root, 'escape/outside.txt')).rejects.toThrow('links');
      await expect(tools.save(root, 'escape/new', 'x', null)).rejects.toThrow('links');
      await link(path.join(outside, 'outside.txt'), path.join(root, 'hard'));
      await expect(tools.read(root, 'hard')).rejects.toThrow('linked');
      expect(await tools.list(root)).toEqual([]);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
  it('keeps an editor lease across saves until the editor releases its clean buffer', async () => {
    const file = await tools.save(root, 'typing.txt', 'initial', null);
    tools.setDirty(root, 'typing.txt', 'editor', true);
    const saved = await tools.save(root, 'typing.txt', 'first keystrokes', file.hash, 'editor');
    await expect(tools.save(root, 'typing.txt', 'agent overwrite', saved.hash)).rejects.toThrow('unsaved');
    tools.setDirty(root, 'typing.txt', 'editor', false);
    expect((await tools.save(root, 'typing.txt', 'after release', saved.hash)).content).toBe('after release');
  });
  it('bounds file reads/writes and rejects binary data', async () => {
    tools = new WorkspaceTools({ maxFileBytes: 10 });
    await writeFile(path.join(root, 'big'), '12345678901');
    await expect(tools.read(root, 'big')).rejects.toThrow('limit');
    await expect(tools.save(root, 'small', '12345678901', null)).rejects.toThrow('limit');
    await writeFile(path.join(root, 'binary'), Buffer.from([0, 1]));
    await expect(tools.read(root, 'binary')).rejects.toThrow('Binary');
  });
  it('searches literal strings and skips protected files and dependency trees', async () => {
    await mkdir(path.join(root, 'nested')); await mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, 'nested', 'a'), 'a.*b\naxxb\n');
    await writeFile(path.join(root, '.env'), 'a.*b=secret');
    await writeFile(path.join(root, 'node_modules', 'dependency'), 'a.*b');
    const result = await tools.execute(context, { name: 'search', args: { query: 'a.*b' } });
    expect(result.ok).toBe(true);
    expect((result.data as any).matches).toEqual([{ path: 'nested/a', line: 1, text: 'a.*b' }]);
  });
  it('validates runtime arguments and classifies all arbitrary execution as elevated', async () => {
    for (const action of [{ name: 'run_shell', args: { command: 'pwd' } }, { name: 'execute_python', args: { code: 'print(1)' } }, { name: 'run_tests', args: { command: 'pytest' } }]) {
      expect(await tools.inspect(context, action)).toMatchObject({ effect: 'execute', risk: 'elevated' });
    }
    expect((await tools.execute(context, { name: 'write_file', args: { path: 'x', content: 'x' } })).ok).toBe(false);
    expect((await tools.execute(context, { name: 'delegate', args: {} })).ok).toBe(false);
    expect((await tools.execute(context, { name: 'run_shell', args: { command: 'pwd', surprise: true } })).ok).toBe(false);
    const controller = new AbortController(); controller.abort();
    expect((await tools.execute({ ...context, signal: controller.signal }, { name: 'write_file', args: { path: 'x', content: 'x', baseHash: null } })).ok).toBe(false);
    expect((await tools.read(root, 'x')).hash).toBeNull();
  });
});

describe('read-only Git and environment', () => {
  it('preserves dirty work and excludes credential content from status and staged/unstaged diffs', async () => {
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    await writeFile(path.join(root, 'a.txt'), 'old\n'); await writeFile(path.join(root, '.env'), 'SECRET=old\n');
    git('add', '.'); git('commit', '-m', 'base');
    await writeFile(path.join(root, 'a.txt'), 'staged\n'); git('add', 'a.txt'); await writeFile(path.join(root, 'a.txt'), 'manual\n');
    await writeFile(path.join(root, '.env'), 'SECRET=private\n');
    const status = await tools.execute(context, { name: 'git_status', args: {} });
    expect(status.ok).toBe(true); expect(status.output).toContain('a.txt'); expect(status.output).not.toContain('.env');
    const diff = await tools.execute(context, { name: 'git_diff', args: {} });
    expect(diff.ok).toBe(true); expect(diff.output).toContain('+manual'); expect(diff.output).toContain('+staged'); expect(diff.output).not.toContain('SECRET');
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('manual\n');
  });
  it('does not invoke repository clean filters during read-only Git tools', async () => {
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    await writeFile(path.join(root, 'a.txt'), 'old\n'); git('add', '.'); git('commit', '-m', 'base');
    await writeFile(path.join(root, '.gitattributes'), '*.txt filter=evil\n');
    git('config', 'filter.evil.clean', 'touch filter-ran; cat');
    git('config', 'filter.evil.required', 'true');
    await writeFile(path.join(root, 'a.txt'), 'changed\n');
    expect((await tools.execute(context, { name: 'git_status', args: {} })).ok).toBe(true);
    expect((await tools.execute(context, { name: 'git_diff', args: {} })).ok).toBe(true);
    expect((await tools.read(root, 'filter-ran')).hash).toBeNull();
  });
  it('rejects Git reads from a subdirectory of a larger repository', async () => {
    git('init'); await mkdir(path.join(root, 'nested'));
    const result = await tools.execute({ ...context, projectRoot: path.join(root, 'nested') }, { name: 'git_status', args: {} });
    expect(result.ok).toBe(false); expect(result.output).toContain('match');
  });
  it('sanitizes secrets and interpreter hooks from child environments', () => {
    expect(childEnvironment({ PATH: '/usr/bin', HOME: '/home/test', STARK_API_KEY: 'secret', OPENAI_API_KEY: 'secret', TOKEN: 'secret', NODE_OPTIONS: '--require exploit', BASH_ENV: '/evil', PYTHONPATH: '/evil' })).toEqual({ PATH: '/usr/bin', HOME: '/home/test', TERM: 'dumb', PS1: '', PS2: '', PROMPT_COMMAND: '', NO_COLOR: '1' });
  });
  it.skipIf(process.platform === 'linux')('reports PTY unavailable honestly on unsupported hosts', async () => {
    const result = await tools.execute(context, { name: 'run_shell', args: { command: 'echo no-fake-success' } });
    expect(result.ok).toBe(false); expect(result.output).toMatch(/Linux\/WSL/);
  });
});

describe('JUnit parsing', () => {
  it.each([
    ['pytest --junitxml=report.xml', 'pytest'],
    ['python -m pytest -q', 'pytest'],
    ['python3.12 -I -m pytest tests', 'pytest'],
    ['".venv/bin/python" -m pytest', 'pytest'],
    ['PYTHONWARNINGS=default .venv/bin/pytest', 'pytest'],
    ['cd tests && pytest --junitxml=../report.xml', 'pytest'],
    ['npm test', 'junit'],
    ['echo "pytest"', 'junit'],
    ['echo "ready && pytest"', 'junit'],
    ['python -c "print(123)" -m pytest', 'junit'],
    ['python -m pytest_extra', 'junit'],
  ])('identifies runner metadata for %s without treating it as success', (command, runner) => {
    expect(parseJUnit('<testsuite><testcase name="case"/></testsuite>', command, { output: '', exitCode: 0 }).runner).toBe(runner);
    expect(unavailableReport(command, { output: '', exitCode: 1 }, 'missing report')).toMatchObject({ runner, status: 'error' });
  });
  it('extracts pass/failure/error/skipped cases and captured traceback/output', () => {
    const report = parseJUnit('<testsuites><testsuite><testcase name="pass" time="0.25"/><testsuite><testcase name="fail"><failure message="assertion">trace</failure><system-out>captured</system-out></testcase><testcase name="skip"><skipped/></testcase><testcase name="collection"><error>import error</error></testcase></testsuite></testsuite></testsuites>', 'pytest', { output: 'runner log', exitCode: 1 });
    expect(report.status).toBe('error'); expect(report.tests.map(t => t.status)).toEqual(['passed', 'failed', 'skipped', 'error']);
    expect(report.tests[1]).toMatchObject({ error: 'assertion\ntrace', output: 'captured' });
  });
  it('never infers passed tests from runner logs or a nonzero exit', () => {
    expect(parseJUnit('<testsuite><testcase name="ok"/></testsuite>', 'pytest', { output: '', exitCode: 2 }).status).toBe('error');
    expect(parseJUnit('<testsuite/>', 'pytest', { output: 'passed!', exitCode: 0 }).status).toBe('error');
    expect(parseJUnit('<testsuite><testcase name="fail"><failure/></testcase></testsuite>', 'pytest', { output: '', exitCode: 1 }).status).toBe('failed');
    expect(parseJUnit('<testsuite><testcase name="ok"/></testsuite>', 'pytest', { output: '', cancelled: true }).status).toBe('cancelled');
  });
  it('rejects malformed, non-JUnit, entity-bearing and oversized reports', () => {
    for (const xml of ['<testsuite>', '<html/>', '<!DOCTYPE a [<!ENTITY secret SYSTEM "file:///etc/passwd">]><testsuite/>']) expect(() => parseJUnit(xml, 'pytest', { output: '', exitCode: 0 })).toThrow();
    expect(() => parseJUnit('<testsuite/>', 'pytest', { output: '', exitCode: 0 }, 5)).toThrow('oversized');
  });
});
