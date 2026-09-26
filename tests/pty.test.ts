import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceTools } from '../server/tools/index.js';
import type { ToolContext, TestReport } from '../shared/types.js';

// These tests MUST run on Linux CI with node-pty installed. Unsupported hosts skip,
// but a Linux host missing node-pty fails rather than silently skipping acceptance.
describe.skipIf(process.platform !== 'linux')('Linux persistent PTY integration', () => {
  let root: string, tools: WorkspaceTools, context: ToolContext;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'harness-pty-')); tools = new WorkspaceTools(); context = { projectRoot: root, chatId: 'chat', agentId: 'coder' }; });
  afterEach(async () => { await tools.dispose(); await rm(root, { recursive: true, force: true }); });
  const shell = (command: string, timeoutMs?: number) => ({ name: 'run_shell', args: { command, ...(timeoutMs ? { timeoutMs } : {}) } });
  it('persists cd and shell variables, isolates agents, and reports exit status', async () => {
    await mkdir(path.join(root, 'sub'));
    expect((await tools.execute(context, shell('cd sub; export RH_TEST=kept'))).ok).toBe(true);
    const next = await tools.execute(context, shell('printf "%s:%s" "$PWD" "$RH_TEST"'));
    expect(next.output).toContain(`${root}/sub:kept`);
    const isolated = await tools.execute({ ...context, agentId: 'other' }, shell('printf "%s:%s" "$PWD" "${RH_TEST-unset}"'));
    expect(isolated.output).toContain(`${root}:unset`);
    expect((await tools.execute(context, shell('false'))).ok).toBe(false);
  });
  it('serializes commands and executes Python in the persistent working directory', async () => {
    const first = tools.execute(context, shell('sleep 0.1; export SERIAL=ready'));
    const second = tools.execute(context, shell('printf "%s" "$SERIAL"'));
    expect((await first).ok).toBe(true); expect((await second).output).toContain('ready');
    const python = await tools.execute(context, { name: 'execute_python', args: { code: 'from pathlib import Path\nPath("python.txt").write_text("actual")\nprint("python works")' } });
    expect(python.ok).toBe(true); expect(await readFile(path.join(root, 'python.txt'), 'utf8')).toBe('actual');
  });
  it('supports commands beyond terminal canonical line limits and removes provider secrets', async () => {
    const previous = process.env.STARK_API_KEY;
    process.env.STARK_API_KEY = 'private-provider-value';
    try {
      const long = await tools.execute(context, { name: 'execute_python', args: { code: `value = "${'x'.repeat(9000)}"\nprint(len(value))` } });
      expect(long.ok).toBe(true); expect(long.output).toContain('9000');
      const environment = await tools.execute(context, shell('printf "%s" "${STARK_API_KEY-unset}"'));
      expect(environment.output).toContain('unset'); expect(environment.output).not.toContain('private-provider-value');
    } finally { if (previous === undefined) delete process.env.STARK_API_KEY; else process.env.STARK_API_KEY = previous; }
  });
  it('bounds output, exposes background jobs, and keeps callback failures harmless', async () => {
    tools = new WorkspaceTools({ maxOutputBytes: 100 });
    const result = await tools.execute({ ...context, onOutput: () => { throw new Error('disconnected'); } }, shell("printf '%02000d' 0"));
    expect(result.ok).toBe(true); expect((result.data as any).truncated).toBe(true); expect((result.data as any).output.length).toBeLessThanOrEqual(100);
    const background = await tools.execute(context, shell('sleep 60 &'));
    expect((background.data as any).backgroundPids.length).toBeGreaterThan(0);
  });
  it('cancels running commands and invalidates queued work after shell state loss', async () => {
    const controller = new AbortController();
    const running = tools.execute({ ...context, signal: controller.signal, onOutput: () => controller.abort() }, shell('printf ready; sleep 30'));
    const queued = tools.execute(context, shell('touch must-not-exist'));
    setTimeout(() => controller.abort(), 700);
    expect((await running).ok).toBe(false); expect((await queued).ok).toBe(false);
    expect((await tools.read(root, 'must-not-exist')).hash).toBeNull();
    expect((await tools.execute(context, shell('printf fresh'))).output).toContain('fresh');
  });
  it('times out and rejects a full command queue', async () => {
    tools = new WorkspaceTools({ maxQueue: 1 });
    const running = tools.execute(context, shell('sleep 30', 250));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect((await tools.execute(context, shell('echo queued'))).output).toContain('full');
    expect((await running).output).toContain('Timed out');
  });
  it('handles shell exit as uncertain rather than successful', async () => {
    const result = await tools.execute(context, shell('exit 0'));
    expect(result.ok).toBe(false); expect(result.output).toContain('uncertain');
  });
  it('parses a freshly generated JUnit artifact and rejects stale or absent artifacts', async () => {
    const report = '<testsuite><testcase name="actual"/></testsuite>';
    const fresh = await tools.execute(context, { name: 'run_tests', args: { command: `printf '${report}' > report.xml`, reportPath: 'report.xml' } });
    expect(fresh.ok).toBe(true); expect(((fresh.data as any).testReport as TestReport).tests[0].name).toBe('actual');
    const stale = await tools.execute(context, { name: 'run_tests', args: { command: 'true', reportPath: 'report.xml' } });
    expect(stale.ok).toBe(false); expect(stale.output).toContain('fresh JUnit');
    await writeFile(path.join(root, 'bad.xml'), '<invalid>');
    const crash = await tools.execute(context, { name: 'run_tests', args: { command: 'exit 1', reportPath: 'new.xml' } });
    expect((crash.data as any).testReport.status).toBe('error');
  });
});
