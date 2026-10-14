import { lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { definitionFor, validateAction } from '../tool-registry.js';
import type { Action, FileChange, FileSnapshot, ToolContext, ToolInspection, ToolResult, ToolService, TestReport } from '../../shared/types.js';
import { patchSnapshot, type LineEdit } from './edits.js';
import {reserveMutation} from './mutations.js';
import { WorkspaceFiles, type FileOptions } from './files.js';
import { allowed, hash, key, leasePath, rootPath, rootPathSync, scoped, ToolError } from './paths.js';
import { ShellPool, gitCommand, type ShellOptions, type CommandResult } from './shell.js';
import { parseJUnit, unavailableReport } from './junit.js';
import { LinuxSandbox, type SandboxPolicy } from './sandbox.js';
export { ToolError } from './paths.js';

const busyReports = new Set<string>();
function validate(action: Action): Record<string, any> {
  if (definitionFor(action.name).kind !== 'workspace') throw new ToolError('Unknown workspace tool.');
  return validateAction(action).args;
}
export interface WorkspaceToolsOptions extends Partial<FileOptions>, Partial<Omit<ShellOptions, 'sandbox'>> { maxReportBytes?: number }
export class WorkspaceTools implements ToolService {
  readonly processLifecycle='sandbox-dispatch-v1' as const;
  private files: WorkspaceFiles;
  private shells: ShellPool;
  readonly sandbox = new LinuxSandbox();
  private disposed = false;
  private removing=new Set<string>();
  private quarantined=new Set<string>();
  private operations = new Map<string,number>();
  private commandOwners=new Map<string,{owner:symbol;count:number}>();
  private mutationGuard: (root:string,owner?:symbol)=>void = () => {};
  configureMutationGuard(guard:(root:string,owner?:symbol)=>void) {this.mutationGuard=guard;}
  private async mutate<T>(root:string,operation:()=>Promise<T>,owner?:symbol):Promise<T> {
    this.mutationGuard(root,owner);
    const reservation=reserveMutation(root,owner);
    try {return await operation();} finally {reservation.release();}
  }
  closeCommandContext(context:ToolContext) {return this.shells.closeContext(context);}
  private async tracked<T>(root: string, operation: () => Promise<T>): Promise<T> {
    this.sandbox.validateRoot(root);
    const id = key(path.resolve(root));
    if(this.removing.has(id) || this.quarantined.has(id))throw new ToolError('Workspace cleanup is pending or uncertain.','CONFLICT');
    this.operations.set(id,(this.operations.get(id) ?? 0)+1);
    try { return await operation(); }
    finally { const count = this.operations.get(id)!-1; if (count) this.operations.set(id,count); else this.operations.delete(id); }
  }
  removeScope<T>(root: string, chatId: string | undefined, mutation: () => T): Promise<T> {
    return this.mutate(root,()=>this.removeScopeInternal(root,chatId,mutation));
  }
  private removeScopeInternal<T>(root: string, chatId: string | undefined, mutation: () => T): Promise<T> {
    this.check();
    const id=key(path.resolve(root));
    if (this.operations.has(id) || this.removing.has(id) || this.quarantined.has(id)) throw new ToolError('A workspace operation is still pending or cleanup is uncertain.','CONFLICT');
    this.files.assertRemovable(root);
    const cleanup=this.shells.removeScope(root,chatId);
    this.removing.add(id);
    return cleanup.catch(error=>{this.quarantined.add(id);throw error;}).then(()=>{this.files.assertRemovable(root);return mutation();}).finally(()=>this.removing.delete(id));
  }
  private maxOutputBytes: number;
  private maxReportBytes: number;
  constructor(options: WorkspaceToolsOptions = {}) {
    for (const [name, value] of Object.entries(options)) if (name !== 'shell' && (!Number.isSafeInteger(value) || Number(value) <= 0)) throw new ToolError(`Invalid tool limit: ${name}`);
    this.maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
    this.maxReportBytes = options.maxReportBytes ?? 2_000_000;
    this.files = new WorkspaceFiles({ maxFileBytes: options.maxFileBytes ?? 2_000_000, maxEntries: options.maxEntries ?? 10_000, maxSearchFiles: options.maxSearchFiles ?? 20_000, leaseMs: options.leaseMs ?? 45_000 });
    this.shells = new ShellPool({ maxOutputBytes: this.maxOutputBytes, maxQueue: options.maxQueue ?? 16, maxSessions: options.maxSessions ?? 32, defaultTimeoutMs: options.defaultTimeoutMs ?? 30_000, maxTimeoutMs: options.maxTimeoutMs ?? 600_000, shell: options.shell ?? '/bin/bash', sandbox:this.sandbox });
  }
  configureSandbox(policy:SandboxPolicy){this.sandbox.configure(policy);}
  resetSandbox(root:string){return this.removeScope(root,undefined,()=>this.sandbox.reset(root));}
  private check(): void { if (this.disposed) throw new ToolError('Tool service has been disposed.'); }
  read(root: string, path: string): Promise<FileSnapshot> { this.check(); return this.tracked(root,()=>this.files.read(root, path)); }
  list(root: string, path = '') { this.check(); return this.tracked(root,()=>this.files.list(root, path)); }
  save(root: string, path: string, content: string, baseHash: string | null, owner?: string) { this.check(); return this.mutate(root,()=>this.tracked(root,()=>this.files.save(root, path, content, baseHash, owner))); }
  setDirty(root: string, path: string, owner: string, dirty: boolean): void { this.check(); if(this.removing.has(key(rootPathSync(root))))throw new ToolError('Workspace cleanup is pending.','CONFLICT');this.sandbox.validateRoot(root);this.files.setDirty(root, path, owner, dirty); }
  restore(root: string, path: string, before: FileSnapshot, expectedHash: string | null, beforeMutation: () => void) {
    this.check();
    return this.mutate(root,()=>this.tracked(root,()=>this.files.save(root, path, before.content, expectedHash, undefined, beforeMutation, before.hash === null)));
  }
  async restoreMove(root: string, change: FileChange, beforeMutation: () => void) {
    this.check();
    const destination = change.destination;
    if (!destination || destination.before.hash !== null || change.after.hash !== null || destination.after.hash === null) throw new ToolError('Invalid move undo.');
    let created = false;
    try { await this.mutate(root,()=>this.tracked(root, () => this.files.move(root, destination.after.path, change.path, destination.after.hash!, () => {created = true;}, beforeMutation))); }
    catch(error) { throw Object.assign(error instanceof Error ? error : new Error('Move undo failed'),{mutation: created ? 'uncertain' : 'not_started'}); }
  }
  private async fileChanges(root: string, action: Action): Promise<NonNullable<ToolInspection['changes']>> {
    const args = action.args;
    const before = await this.read(root, String(args.path));
    if (before.hash !== args.baseHash) throw new ToolError('Edit is based on a stale file version.', 'CONFLICT');
    if (action.name === 'delete_file' || action.name === 'rename_file') {
      if (before.hash === null) throw new ToolError('The source file is missing.', 'CONFLICT');
      const changes = [{before, after: {path: before.path, content: '', hash: null as string | null}}];
      if (action.name === 'rename_file') {
        const destination = await this.read(root, String(args.destination));
        if (key(leasePath(root,before.path)) === key(leasePath(root,destination.path)) || destination.hash !== null) throw new ToolError('Rename destination must be different and absent.', 'CONFLICT');
        changes.push({before: destination, after: {...before, path: destination.path}});
      }
      return changes;
    }
    const after = action.name === 'write_file' ? {path: before.path, content: String(args.content), hash: hash(String(args.content))} : patchSnapshot(before, args.edits as LineEdit[]);
    const limit = action.name === 'maintain_instructions' ? 32_000 : this.files.options.maxFileBytes;
    if (Buffer.byteLength(after.content) > limit || after.content.includes('\0') || Buffer.from(after.content).toString('utf8') !== after.content) throw new ToolError('Invalid content or file exceeds size limit.');
    return [{before, after}];
  }
  async inspect(context: ToolContext, action: Action): Promise<ToolInspection> {
    return this.tracked(context.projectRoot,()=>this.inspectInternal(context,action));
  }
  private async inspectInternal(context: ToolContext, action: Action): Promise<ToolInspection> {
    this.check(); const args = validate(action);
    await rootPath(context.projectRoot);
    if (args.path !== undefined) await scoped(context.projectRoot, args.path, ['list_files', 'search', 'search_page', 'git_diff'].includes(action.name));
    if (definitionFor(action.name).fileMutation) {
      const changes = await this.fileChanges(context.projectRoot, action);
      if (changes.reduce((bytes, change) => bytes + Buffer.byteLength(change.before.content) + Buffer.byteLength(change.after.content),0) > 200_000) throw new ToolError('Diff exceeds the 200 KB review limit.');
      const diff = changes.map(({before,after}) => {const patch=createTwoFilesPatch(before.hash === null ? '/dev/null' : before.path, after.hash === null ? '/dev/null' : after.path, before.content, after.content, '', '', {context: 3, timeout: 1000});if(typeof patch!=='string')throw new ToolError('Diff computation exceeded its bound.');return patch;}).join('\n');
      if (Buffer.byteLength(diff) > 200_000) throw new ToolError('Diff exceeds the 200 KB review limit.');
      return {effect: 'write', risk: 'routine', description: `${action.name}: ${changes.map(change=>change.before.path).join(' → ')}`, path: args.path, before: changes[0].before.content, after: changes[0].after.content, diff, changes};
    }
    if (definitionFor(action.name).command) {
      if (args.reportPath) await scoped(context.projectRoot, args.reportPath);
      return { effect: 'execute', risk: 'elevated', description: `${action.name}: sandboxed execution can modify the selected project and private dependencies. Registry-only network capability. Requires runtime authorization.` };
    }
    return { effect: 'read', risk: 'routine', description: action.name, ...(args.path !== undefined ? { path: args.path } : {}) };
  }
  // This is an execution primitive for the trusted runtime, never a model-facing approval bypass.
  async execute(context: ToolContext, action: Action): Promise<ToolResult> {
    const operation=()=>this.tracked(context.projectRoot,()=>this.executeInternal(context,action));
    if(definitionFor(action.name).effect==='read')return operation();
    let slot:string|undefined;
    let owner=context.mutationOwner;
    if(!owner&&definitionFor(action.name).command){slot=JSON.stringify([rootPathSync(context.projectRoot),context.chatId,context.agentId]);const existing=this.commandOwners.get(slot)??{owner:Symbol('serialized shell queue'),count:0};existing.count++;this.commandOwners.set(slot,existing);owner=existing.owner;}
    try {return await this.mutate(context.projectRoot,operation,owner);}
    catch(error) {return {ok:false,output:error instanceof Error?error.message:'Mutation unavailable',data:{status:'not_started'}};}
    finally {if(slot){const existing=this.commandOwners.get(slot)!;if(--existing.count===0)this.commandOwners.delete(slot);}}
  }
  private async executeInternal(context: ToolContext, action: Action): Promise<ToolResult> {
    let fileMutationStarted = false;
    try {
      this.check(); const args = validate(action);
      if (context.signal?.aborted) return { ok: false, output: 'Cancelled before execution.' };
      const root = rootPathSync(context.projectRoot);
      if (definitionFor(action.name).fileMutation) {
        const changes = await this.fileChanges(root, action), change = changes[0];
        if (action.name === 'rename_file') {
          const result = await this.files.move(root, args.path, args.destination, args.baseHash, () => {fileMutationStarted = true;});
          return {ok: true, output: `Moved ${result.source.path} to ${result.destination.path}`, data: {...result.source, snapshots: [result.source, result.destination]}};
        }
        const result = await this.files.save(root, args.path, change.after.content, args.baseHash, context.agentId, () => {fileMutationStarted = true;}, action.name === 'delete_file');
        return {ok: true, output: `${action.name === 'delete_file' ? 'Removed' : 'Saved'} ${result.path}`, data: {...result, snapshots: [result]}};
      }
      switch (action.name) {
        case 'read_file_range': { const data = await this.files.range(root,args.path,args.startLine,args.count); return {ok: data.hash !== null, output: data.content, data}; }
        case 'search_page': { const data = await this.files.searchPage(root,args.query,args.path,args.offset,args.limit,args.revision); return {ok: true, output: JSON.stringify(data), data}; }
        case 'read_file': { const file = await this.read(root, args.path); return { ok: file.hash !== null, output: file.hash === null ? `File not found: ${file.path}` : file.content, data: file }; }
        case 'list_files': { const entries = await this.list(root, args.path); return { ok: true, output: JSON.stringify(entries), data: entries }; }
        case 'search': { const result = await this.files.search(root, args.query, args.path); return { ok: true, output: JSON.stringify(result), data: result }; }
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
    } catch (error) { return { ok: false, output: error instanceof Error ? error.message : 'Tool operation failed.', data: {...(error instanceof ToolError ? {code:error.code} : {}),...(definitionFor(action.name).fileMutation ? {mutation:fileMutationStarted ? 'uncertain' : 'not_started', uncertain: fileMutationStarted} : {})} }; }
  }
  private commandResult(result: CommandResult): ToolResult {
    return { ok: result.exitCode === 0 && !result.error && !result.cancelled && !result.timedOut, output: [result.output, result.error, result.truncated ? '[Output truncated]' : ''].filter(Boolean).join('\n'), data: result };
  }
  private async assertGitRoot(root: string, signal?: AbortSignal): Promise<void> {
    if(!existsSync(path.join(root,'.git')))throw new ToolError('Git working tree must match the workspace root.');
    const result = await gitCommand(root, ['rev-parse', '--show-toplevel'], this.maxOutputBytes, signal, this.sandbox);
    if (result.exitCode !== 0 || result.error) throw new ToolError('Workspace root is not an available Git working tree.');
    if (key(await rootPath(result.output.trim())) !== key(root)) throw new ToolError('Git working tree must match the workspace root.');
  }
  private async gitStatus(root: string, signal?: AbortSignal): Promise<ToolResult> {
    await this.assertGitRoot(root, signal);
    const result = await gitCommand(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], this.maxOutputBytes, signal, this.sandbox);
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
      const names = await gitCommand(root, ['diff', ...flags, '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', '--', ...(requested ? [requested] : [])], this.maxOutputBytes, signal, this.sandbox);
      if (names.exitCode !== 0 || names.error) return this.commandResult(names);
      if (names.truncated) throw new ToolError('Git paths exceed output limit. Select a narrower path.');
      const paths: string[] = [];
      for (const name of names.output.split('\0').filter(Boolean)) if (allowed(name)) { await scoped(root, name); paths.push(name); }
      if (!paths.length) continue;
      // Disabling rename detection avoids showing the old contents of a protected file.
      for (let index = 0; index < paths.length; index += 100) {
        const result = await gitCommand(root, ['diff', ...flags, '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', '--', ...paths.slice(index, index + 100)], this.maxOutputBytes, signal, this.sandbox);
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
  async dispose(): Promise<void> { this.disposed = true; await this.shells.dispose();if(this.quarantined.size)throw new ToolError('Sandbox cleanup is uncertain; retain backend ownership.','SANDBOX_CLEANUP_FAILED'); }
}
