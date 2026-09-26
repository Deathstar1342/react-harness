import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { IPty } from 'node-pty';
import type { ToolContext } from '../../shared/types.js';
import { rootPathSync, ToolError } from './paths.js';

export function childEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (source[name] !== undefined) result[name] = source[name]!;
  }
  return { ...result, TERM: 'dumb', PS1: '', PS2: '', PROMPT_COMMAND: '', NO_COLOR: '1' };
}
export interface CommandResult { output: string; exitCode?: number; cancelled?: boolean; timedOut?: boolean; truncated?: boolean; error?: string; backgroundPids?: number[]; shellReset?: boolean }
export interface ShellOptions { maxOutputBytes: number; maxQueue: number; maxSessions: number; defaultTimeoutMs: number; maxTimeoutMs: number; shell: string }
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
class PersistentShell {
  private active?: { nonce: string; output: string; buffer: string; bytes: number; truncated: boolean; finish: (result: CommandResult) => void; onOutput?: (output: string) => void };
  private dead = false;
  private terminated = false;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private startup = '';
  private readyNonce = randomBytes(24).toString('hex');
  private disposables: { dispose(): void }[] = [];
  private constructor(readonly pty: IPty, private limit: number) {}
  static async create(root: string, options: ShellOptions): Promise<PersistentShell> {
    if (process.platform !== 'linux') throw new ToolError('Persistent shells require Linux/WSL and optional node-pty. Start this backend inside a Linux/WSL environment.', 'PTY_UNAVAILABLE');
    let native;
    try { native = await import('node-pty'); } catch { throw new ToolError('node-pty is unavailable. Install optional dependencies and build prerequisites in Linux/WSL, then restart the backend.', 'PTY_UNAVAILABLE'); }
    let terminal: IPty;
    try { terminal = native.spawn(options.shell, ['--noprofile', '--norc', '--noediting', '-i'], { cwd: root, env: childEnvironment(), name: 'dumb', cols: 120, rows: 30 }); }
    catch { throw new ToolError('Cannot start bash PTY. Verify bash, node-pty, and Linux build prerequisites.', 'PTY_UNAVAILABLE'); }
    const session = new PersistentShell(terminal, options.maxOutputBytes);
    session.disposables.push(terminal.onData(data => session.receive(data)), terminal.onExit(({ exitCode }) => {
      session.dead = true;
      session.readyReject?.(new ToolError('Shell exited during startup.', 'PTY_UNAVAILABLE'));
      session.active?.finish({ output: session.active.output, exitCode, error: 'Persistent shell exited before a command boundary; outcome may be uncertain. Shell state was lost.', shellReset: true });
    }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { session.kill(); reject(new ToolError('PTY startup timed out.', 'PTY_UNAVAILABLE')); }, 5000);
      session.readyResolve = () => { clearTimeout(timer); resolve(); };
      session.readyReject = error => { clearTimeout(timer); reject(error); };
      terminal.write(`stty -echo -icanon; set +m; unset PROMPT_COMMAND; PS1=; PS2=; printf '\\036RH_READY_${session.readyNonce}\\037'\n`);
    });
    return session;
  }
  get alive(): boolean { return !this.dead; }
  private receive(data: string): void {
    if (this.readyResolve) {
      this.startup = (this.startup + data).slice(-8192);
      const marker = `\x1eRH_READY_${this.readyNonce}\x1f`, index = this.startup.indexOf(marker);
      if (index < 0) return;
      const resolve = this.readyResolve;
      this.readyResolve = undefined; this.readyReject = undefined;
      data = this.startup.slice(index + marker.length); this.startup = '';
      resolve();
    }
    const active = this.active;
    if (!active) return; // Unassociated background output is never credited to a later command.
    active.buffer += data;
    const prefix = `\x1eRH_${active.nonce}:`, start = active.buffer.indexOf(prefix);
    if (start >= 0) {
      const end = active.buffer.indexOf('\x1f', start);
      if (end >= 0) {
        this.output(active.buffer.slice(0, start));
        const boundary = active.buffer.slice(start + prefix.length, end);
        const match = /^(\d+):([\d,]*)$/.exec(boundary);
        if (!match) { this.kill(); active.finish({ output: active.output, error: 'Invalid command boundary; shell state was discarded.', shellReset: true }); return; }
        active.finish({ output: active.output, exitCode: Number(match[1]), truncated: active.truncated, backgroundPids: match[2].split(',').filter(Boolean).map(Number) });
        return;
      }
    }
    if (start >= 0) {
      this.output(active.buffer.slice(0, start)); active.buffer = active.buffer.slice(start);
      if (active.buffer.length > prefix.length + 4096) { this.kill(); active.finish({ output: active.output, error: 'Oversized command boundary; shell state was discarded.', shellReset: true }); }
    } else {
      let keep = Math.min(active.buffer.length, prefix.length - 1);
      while (keep && !prefix.startsWith(active.buffer.slice(-keep))) keep--;
      const emitted = keep ? active.buffer.slice(0, -keep) : active.buffer;
      active.buffer = keep ? active.buffer.slice(-keep) : '';
      this.output(emitted);
    }
  }
  private output(text: string): void {
    const active = this.active;
    if (!active || !text) return;
    const bytes = Buffer.from(text), remaining = Math.max(0, this.limit - active.bytes);
    const output = bytes.subarray(0, remaining).toString('utf8');
    active.bytes += Math.min(bytes.length, remaining);
    if (bytes.length > remaining) active.truncated = true;
    active.output += output;
    if (output) { try { active.onOutput?.(output); } catch { /* A disconnected listener must not orphan execution. */ } }
  }
  run(command: string, timeoutMs: number, signal?: AbortSignal, onOutput?: (text: string) => void): Promise<CommandResult> {
    if (this.dead) return Promise.reject(new ToolError('Shell exited; retry explicitly to create a fresh session.'));
    if (signal?.aborted) return Promise.resolve({ output: '', cancelled: true, error: 'Cancelled before execution.' });
    return new Promise(resolve => {
      const nonce = randomBytes(24).toString('hex');
      const finish = (result: CommandResult) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.active = undefined; resolve(result); };
      const stop = (cancelled: boolean) => {
        this.output(this.active?.buffer ?? '');
        const output = this.active?.output ?? '';
        this.kill();
        finish({ output, cancelled, timedOut: !cancelled, error: `${cancelled ? 'Cancelled' : 'Timed out'}; shell and its process group were terminated. Shell state was lost; completed side effects were not rolled back.`, shellReset: true });
      };
      const abort = () => stop(true);
      const timer = setTimeout(() => stop(false), timeoutMs);
      this.active = { nonce, output: '', buffer: '', bytes: 0, truncated: false, finish, onOutput };
      signal?.addEventListener('abort', abort, { once: true });
      this.pty.write(`eval ${quote(command)}\n__rh_status=$?; printf '\\036RH_${nonce}:%s:%s\\037' "$__rh_status" "$(jobs -pr | tr '\\n' ',')"\n`);
    });
  }
  kill(): void {
    if (!this.terminated) {
      this.terminated = true;
      this.dead = true;
      try { process.kill(-this.pty.pid, 'SIGKILL'); } catch { /* May already have exited. */ }
      try { this.pty.kill('SIGKILL'); } catch { /* May already have exited. */ }
    }
  }
  dispose(): void {
    this.kill();
    this.active?.finish({ output: this.active.output, cancelled: true, error: 'Tool service disposed; shell state was lost.', shellReset: true });
    for (const listener of this.disposables) listener.dispose();
  }
}
export class ShellPool {
  private sessions = new Map<string, PersistentShell>();
  private queues = new Map<string, { tail: Promise<void>; count: number; generation: number }>();
  private disposed = false;
  constructor(readonly options: ShellOptions) {}
  async run(context: ToolContext, command: string, timeoutMs = this.options.defaultTimeoutMs, beforeRun?: () => Promise<void>, afterRun?: (result: CommandResult) => Promise<void>): Promise<CommandResult> {
    if (this.disposed) throw new ToolError('Tool service has been disposed.');
    const root = rootPathSync(context.projectRoot), id = JSON.stringify([root, context.chatId, context.agentId]);
    if (!this.queues.has(id) && this.queues.size >= this.options.maxSessions) throw new ToolError('Persistent shell session limit reached.');
    const queue = this.queues.get(id) ?? { tail: Promise.resolve(), count: 0, generation: 0 };
    this.queues.set(id, queue);
    if (queue.count >= this.options.maxQueue) throw new ToolError('Shell command queue is full.');
    queue.count++;
    const generation = queue.generation;
    const result = queue.tail.then(async () => {
      if (this.disposed || context.signal?.aborted) return { output: '', cancelled: true, error: 'Cancelled before execution.' };
      if (generation !== queue.generation) return { output: '', error: 'A prior command lost shell state; queued command was not executed. Submit again explicitly.', shellReset: true };
      let session = this.sessions.get(id);
      if (session && !session.alive) { session.dispose(); this.sessions.delete(id); queue.generation++; return { output: '', error: 'Shell exited between commands. Submit again explicitly to start a fresh shell.', shellReset: true }; }
      if (!session) { session = await PersistentShell.create(root, this.options); this.sessions.set(id, session); }
      if (this.disposed) { session.dispose(); this.sessions.delete(id); return { output: '', cancelled: true, error: 'Tool service disposed before execution.' }; }
      await beforeRun?.();
      const outcome = await session.run(command, Math.min(timeoutMs, this.options.maxTimeoutMs), context.signal, context.onOutput);
      if (outcome.shellReset) { session.dispose(); this.sessions.delete(id); queue.generation++; }
      await afterRun?.(outcome);
      return { ...outcome, shellReset: outcome.shellReset || generation > 0 };
    }).finally(() => { queue.count--; });
    queue.tail = result.then(() => {}, () => {});
    return result;
  }
  async dispose(): Promise<void> { this.disposed = true; for (const session of this.sessions.values()) session.dispose(); await Promise.all([...this.queues.values()].map(q => q.tail)); this.sessions.clear(); this.queues.clear(); }
}
// Direct execution is reserved for fixed, read-only Git argv; model commands use the PTY.
export async function gitCommand(root: string, args: string[], maxBytes: number, signal?: AbortSignal): Promise<CommandResult> {
  if (signal?.aborted) return { output: '', cancelled: true };
  // Git diff/status may execute configured clean filters even with --no-textconv.
  // Discover only config key names, never values (which may contain credentials).
  const overrides: string[] = [];
  if (args[0] !== 'config') {
    const config = await gitCommand(root, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], maxBytes, signal);
    if (config.error || config.cancelled || config.timedOut || (config.exitCode !== 0 && config.exitCode !== 1)) return { output: '', error: 'Cannot safely inspect Git filter configuration.' };
    for (const name of new Set(config.output.split('\0').filter(Boolean).map(key => key.replace(/\.(clean|smudge|process|required)$/, '')))) {
      for (const operation of ['clean', 'smudge', 'process']) overrides.push('-c', `${name}.${operation}=`);
      overrides.push('-c', `${name}.required=false`);
    }
  }
  return new Promise(resolve => {
    let output = '', bytes = 0, truncated = false, done = false;
    const env = { ...childEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' };
    const child = spawn('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...overrides, ...args], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (result: CommandResult) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(result); };
    const abort = () => { child.kill(); finish({ output, cancelled: true, error: 'Git command cancelled.' }); };
    const timer = setTimeout(() => { child.kill(); finish({ output, timedOut: true, error: 'Git command timed out.' }); }, 15000);
    signal?.addEventListener('abort', abort, { once: true });
    const collect = (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) { truncated = true; child.kill(); } else output += chunk.toString('utf8'); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', () => finish({ output: '', error: 'Git is unavailable or could not start.' }));
    child.on('close', code => finish({ output, ...(code !== null ? { exitCode: code } : {}), truncated, ...(truncated ? { error: 'Git output limit exceeded.' } : {}) }));
  });
}
