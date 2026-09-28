import { lstat } from 'node:fs/promises';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import type { Action, FileSnapshot, ToolContext, ToolInspection, ToolResult, ToolService, TestReport } from '../../shared/types.js';
import { WorkspaceFiles, type FileOptions } from './files.js';
import { allowed, key, leasePath, rootPath, rootPathSync, scoped, ToolError } from './paths.js';
import { ShellPool, gitCommand, type ShellOptions, type CommandResult } from './shell.js';
import { parseJUnit, unavailableReport } from './junit.js';
export { ToolError } from './paths.js';

const busyReports = new Set<string>();
const pathArg = z.string().max(4096);
const timeout = z.number().int().min(1).max(600_000).optional();
const schemas: Record<string, z.ZodType> = {
  list_files: z.object({ path: pathArg.optional() }).strict(),
  read_file: z.object({ path: pathArg.min(1) }).strict(),
  search: z.object({ query: z.string().min(1).max(1000), path: pathArg.optional() }).strict(),
  write_file: z.object({ path: pathArg.min(1), content: z.string(), baseHash: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict(),
  run_shell: z.object({ command: z.string().min(1).max(64_000), timeoutMs: timeout }).strict(),
  execute_python: z.object({ code: z.string().min(1).max(64_000), timeoutMs: timeout }).strict(),
  git_status: z.object({}).strict(),
  git_diff: z.object({ path: pathArg.optional() }).strict(),
  run_tests: z.object({ command: z.string().min(1).max(64_000), reportPath: pathArg.min(1).optional(), timeoutMs: timeout }).strict(),
};
function validate(action: Action): Record<string, any> {
  const schema = Object.hasOwn(schemas, action?.name ?? '') ? schemas[action.name] : undefined;
  if (!schema) throw new ToolError('Unknown workspace tool. Runtime actions must be handled by the orchestrator.');
  const parsed = schema.safeParse(action.args);
  if (!parsed.success) throw new ToolError(`Invalid ${action.name} arguments: ${parsed.error.issues.map(i => i.path.join('.') + ' ' + i.message).join('; ')}`);
  return parsed.data as Record<string, any>;
}
export interface WorkspaceToolsOptions extends Partial<FileOptions>, Partial<ShellOptions> { maxReportBytes?: number }
export class WorkspaceTools implements ToolService {
  private files: WorkspaceFiles;
  private shells: ShellPool;
  private disposed = false;
  private maxOutputBytes: number;
  private maxReportBytes: number;
  constructor(options: WorkspaceToolsOptions = {}) {
    for (const [name, value] of Object.entries(options)) if (name !== 'shell' && (!Number.isSafeInteger(value) || Number(value) <= 0)) throw new ToolError(`Invalid tool limit: ${name}`);
    this.maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
    this.maxReportBytes = options.maxReportBytes ?? 2_000_000;
    this.files = new WorkspaceFiles({ maxFileBytes: options.maxFileBytes ?? 2_000_000, maxEntries: options.maxEntries ?? 10_000, maxSearchFiles: options.maxSearchFiles ?? 20_000, leaseMs: options.leaseMs ?? 45_000 });
    this.shells = new ShellPool({ maxOutputBytes: this.maxOutputBytes, maxQueue: options.maxQueue ?? 16, maxSessions: options.maxSessions ?? 32, defaultTimeoutMs: options.defaultTimeoutMs ?? 30_000, maxTimeoutMs: options.maxTimeoutMs ?? 600_000, shell: options.shell ?? '/bin/bash' });
  }
  private check(): void { if (this.disposed) throw new ToolError('Tool service has been disposed.'); }
  read(root: string, path: string): Promise<FileSnapshot> { this.check(); return this.files.read(root, path); }
  list(root: string, path = '') { this.check(); return this.files.list(root, path); }
  save(root: string, path: string, content: string, baseHash: string | null, owner?: string) { this.check(); return this.files.save(root, path, content, baseHash, owner); }
  setDirty(root: string, path: string, owner: string, dirty: boolean): void { this.check(); this.files.setDirty(root, path, owner, dirty); }
  restore(root: string, path: string, before: FileSnapshot, expectedHash: string, beforeMutation: () => void) {
    this.check();
    return this.files.save(root, path, before.content, expectedHash, undefined, beforeMutation, before.hash === null);
  }
  async inspect(context: ToolContext, action: Action): Promise<ToolInspection> {
    this.check(); const args = validate(action);
    await rootPath(context.projectRoot);
    if (args.path !== undefined) await scoped(context.projectRoot, args.path, ['list_files', 'search', 'git_diff'].includes(action.name));
    if (action.name === 'write_file') {
      if (Buffer.byteLength(args.content) > this.files.options.maxFileBytes || args.content.includes('\0')) throw new ToolError('Invalid content or file exceeds size limit.');
      const before = await this.read(context.projectRoot, args.path);
      if (before.hash !== args.baseHash) throw new ToolError('Edit is based on a stale file version.', 'CONFLICT');
      const diff = createTwoFilesPatch(before.hash === null ? '/dev/null' : args.path, args.path, before.content, args.content, '', '', { context: 3 });
      return { effect: 'write', risk: 'routine', description: `Write ${args.path}`, path: args.path, before: before.content, after: args.content, diff };
    }
    if (['run_shell', 'execute_python', 'run_tests'].includes(action.name)) {
      if (args.reportPath) await scoped(context.projectRoot, args.reportPath);
      return { effect: 'execute', risk: 'elevated', description: `${action.name}: arbitrary execution can modify files and access resources outside the working directory. Requires runtime authorization; cwd is not a sandbox.` };
    }
    return { effect: 'read', risk: 'routine', description: action.name, ...(args.path !== undefined ? { path: args.path } : {}) };
  }
  // This is an execution primitive for the trusted runtime, never a model-facing approval bypass.
  async execute(context: ToolContext, action: Action): Promise<ToolResult> {
    let fileMutationStarted = false;
    try {
      this.check(); const args = validate(action);
      if (context.signal?.aborted) return { ok: false, output: 'Cancelled before execution.' };
      const root = rootPathSync(context.projectRoot);
      switch (action.name) {
        case 'read_file': { const file = await this.read(root, args.path); return { ok: file.hash !== null, output: file.hash === null ? `File not found: ${file.path}` : file.content, data: file }; }
        case 'list_files': { const entries = await this.list(root, args.path); return { ok: true, output: JSON.stringify(entries), data: entries }; }
        case 'search': { const result = await this.files.search(root, args.query, args.path); return { ok: true, output: JSON.stringify(result), data: result }; }
        case 'write_file': { const result = await this.files.save(root, args.path, args.content, args.baseHash, context.agentId,()=>{fileMutationStarted=true;}); return { ok: true, output: `Saved ${result.path}`, data: result }; }
        case 'run_shell': return this.commandResult(await this.shells.run(context, args.command, args.timeoutMs));
        case 'execute_python': {
          const encoded = Buffer.from(args.code).toString('base64');
          const command = `python3 -c 'import base64; exec(compile(base64.b64decode("${encoded}"), "<workspace-python>", "exec"))'`;
          return this.commandResult(await this.shells.run(context, command, args.timeoutMs));
        }
        case 'run_tests': return await this.runTests(context, args);
        case 'git_status': return await this.gitStatus(root, context.signal);
        case 'git_diff': return await this.gitDiff(root, args.path, context.signal);
        default: throw new ToolError('Unknown workspace tool.');
      }
    } catch (error) { return { ok: false, output: error instanceof Error ? error.message : 'Tool operation failed.', data: {...(error instanceof ToolError ? {code:error.code} : {}),...(action.name === 'write_file' ? {mutation:fileMutationStarted ? 'uncertain' : 'not_started'} : {})} }; }
  }
  private commandResult(result: CommandResult): ToolResult {
    return { ok: result.exitCode === 0 && !result.error && !result.cancelled && !result.timedOut, output: [result.output, result.error, result.truncated ? '[Output truncated]' : ''].filter(Boolean).join('\n'), data: result };
  }
  private async assertGitRoot(root: string, signal?: AbortSignal): Promise<void> {
    const result = await gitCommand(root, ['rev-parse', '--show-toplevel'], this.maxOutputBytes, signal);
    if (result.exitCode !== 0 || result.error) throw new ToolError('Workspace root is not an available Git working tree.');
    if (key(await rootPath(result.output.trim())) !== key(root)) throw new ToolError('Git working tree must match the workspace root.');
  }
  private async gitStatus(root: string, signal?: AbortSignal): Promise<ToolResult> {
    await this.assertGitRoot(root, signal);
    const result = await gitCommand(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], this.maxOutputBytes, signal);
    if (result.exitCode !== 0 || result.error) return this.commandResult(result);
    if (result.truncated) throw new ToolError('Git status exceeds output limit.');
    const raw = result.output.split('\0'), entries: { status: string; path: string; originalPath?: string }[] = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i]; if (!item) continue;
      const status = item.slice(0, 2), relative = item.slice(3);
      const original = /[RC]/.test(status) ? raw[++i] : undefined;
      if (!allowed(relative) || (original && !allowed(original))) continue;
      await scoped(root, relative);
      entries.push({ status, path: relative, ...(original ? { originalPath: original } : {}) });
    }
    return { ok: true, output: JSON.stringify(entries), data: entries };
  }
  private async gitDiff(root: string, input?: string, signal?: AbortSignal): Promise<ToolResult> {
    await this.assertGitRoot(root, signal);
    const requested = input !== undefined ? (await scoped(root, input, true)).relative : '';
    const sections: string[] = [];
    for (const cached of [false, true]) {
      const flags = cached ? ['--cached'] : [];
      const names = await gitCommand(root, ['diff', ...flags, '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', '--', ...(requested ? [requested] : [])], this.maxOutputBytes, signal);
      if (names.exitCode !== 0 || names.error) return this.commandResult(names);
      if (names.truncated) throw new ToolError('Git paths exceed output limit. Select a narrower path.');
      const paths: string[] = [];
      for (const name of names.output.split('\0').filter(Boolean)) if (allowed(name)) { await scoped(root, name); paths.push(name); }
      if (!paths.length) continue;
      // Disabling rename detection avoids showing the old contents of a protected file.
      for (let index = 0; index < paths.length; index += 100) {
        const result = await gitCommand(root, ['diff', ...flags, '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', '--', ...paths.slice(index, index + 100)], this.maxOutputBytes, signal);
        if (result.exitCode !== 0 || result.error) return this.commandResult(result);
        if (result.truncated) throw new ToolError('Git diff exceeds output limit. Select a narrower path.');
        sections.push(`${cached ? 'Staged' : 'Unstaged'} changes:\n${result.output}`);
        if (Buffer.byteLength(sections.join('\n')) > this.maxOutputBytes) throw new ToolError('Git diff exceeds output limit. Select a narrower path.');
      }
    }
    return { ok: true, output: sections.join('\n') };
  }
  private async runTests(context: ToolContext, args: Record<string, any>): Promise<ToolResult> {
    const reportPath = args.reportPath ?? '.react-harness-test-results.xml';
    const target = { absolute: leasePath(context.projectRoot, reportPath) };
    const signature = async () => {
      await scoped(context.projectRoot, reportPath);
      try { const s = await lstat(target.absolute, { bigint: true }); return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    };
    let before: string | null = null;
    let acquired = false;
    const releaseReport = () => { if (acquired) busyReports.delete(target.absolute); acquired = false; };
    let result: CommandResult;
    let report: TestReport | undefined;
    const captureReport = async (outcome: CommandResult) => {
      try {
        if (outcome.error || outcome.cancelled || outcome.timedOut) throw new ToolError(outcome.error ?? 'Test execution did not finish.');
        const after = await signature();
        if (after === null || after === before) throw new ToolError('Runner did not produce a fresh JUnit report. Configure the command to write reportPath; stale reports are never treated as new results.');
        const snapshot = await this.read(context.projectRoot, reportPath);
        if (snapshot.hash === null) throw new ToolError('JUnit report is missing.');
        report = parseJUnit(snapshot.content, args.command, outcome, this.maxReportBytes);
      } catch (error) { report = unavailableReport(args.command, outcome, error instanceof Error ? error.message : 'JUnit report unavailable.'); }
      finally { releaseReport(); }
    };
    try { result = await this.shells.run(context, args.command, args.timeoutMs, async () => {
      if (busyReports.has(target.absolute)) throw new ToolError('Another test run is writing this report. Use a distinct reportPath or wait for it to finish.');
      busyReports.add(target.absolute); acquired = true; before = await signature();
    }, captureReport); }
    catch (error) { result = { output: '', error: error instanceof Error ? error.message : 'Test runner could not start.' }; }
    finally { releaseReport(); }
    report ??= unavailableReport(args.command, result, result.error ?? 'Test command was not executed.');
    return { ok: report.status === 'passed', output: report.output, data: { ...result, reportPath, testReport: report } };
  }
  async dispose(): Promise<void> { this.disposed = true; await this.shells.dispose(); }
}
