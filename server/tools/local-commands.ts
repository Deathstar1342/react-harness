import { spawn, execFile } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolContext } from '../../shared/types.js';
import { key, rootPathSync, safeRelative, ToolError } from './paths.js';
import { childEnvironment, type CommandResult, type ShellOptions } from './shell.js';

const windows = process.platform === 'win32';
const fileCommands = new Set(['ls', 'dir', 'get-childitem', 'mkdir', 'md', 'rm', 'remove-item', 'del', 'erase', 'rmdir', 'rd', 'pwd']);
const systemInstallers=new Set(['apt','apt-get','dpkg','dnf','yum','pacman','zypper','apk','winget','choco','scoop','msiexec']);
const nestedShells = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'cmd', 'powershell', 'pwsh', 'wsl', 'sudo', 'doas', 'runas']);
const worker = fileURLToPath(new URL('./workspace-file-command.mjs', import.meta.url));

export function commandDirectory(root: string, cwd = '.') {
  const canonical = rootPathSync(root);
  if (key(canonical) !== key(path.resolve(root))) throw new ToolError('Workspace root changed or is linked.');
  let current = canonical;
  for (const part of safeRelative(cwd, true).split('/').filter(Boolean)) {
    current = path.join(current, part);
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ToolError('Use an existing, unlinked workspace directory.');
  }
  const info = lstatSync(current);
  if (key(realpathSync(current)) !== key(current)) throw new ToolError('Workspace working directory is linked.');
  const rootInfo = lstatSync(canonical);
  return { directory: current, stamp: [rootInfo.dev, rootInfo.ino, info.dev, info.ino].join(':') };
}

// A single argv invocation. Quotes group literal arguments but add no shell authority.
function commandArguments(command: string): string[] {
  const args: string[] = [];
  let value = '', quote = '', started = false;
  for (const character of command) {
    if (character === quote) { quote = ''; continue; }
    if (quote) { value += character; continue; }
    if (character === '"' || character === "'") { quote = character; started = true; continue; }
    if (/[\r\n;&|<>`$]/.test(character)) throw new ToolError('Use one command with literal arguments. Shell substitutions, pipes and redirects are unavailable.');
    if (/\s/.test(character)) {
      if (started) args.push(value);
      value = ''; started = false; continue;
    }
    value += character; started = true;
  }
  if (quote) throw new ToolError('Command has an unmatched quote.');
  if (started) args.push(value);
  if (!args.length || args.length > 128) throw new ToolError('Use one command with at most 127 arguments.');
  return args;
}

function checkedTarget(root: string, directory: string, operand: string) {
  const relative = safeRelative(operand, true);
  let current = directory;
  for (const part of relative.split('/').filter(Boolean)) {
    current = path.join(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1) || !info.isFile() && !info.isDirectory()) throw new ToolError('Linked and special workspace paths are unavailable.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (key(current)!==key(root) && !key(current).startsWith(key(root)+path.sep)) throw new ToolError('Command target leaves the workspace.');
  return current;
}

function localInvocation(context: ToolContext, directory: string, command: string) {
  const [file, ...args] = commandArguments(command);
  const name = file.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/i, '');
  if (systemInstallers.has(name) || ['npm','pnpm','yarn'].includes(name) && args.some(argument=>/^(?:-g|--global(?:=|$))/.test(argument))) throw new ToolError('Use the separate system-install approval flow.');
  if (nestedShells.has(name) || /\.(?:cmd|bat|ps1)$/i.test(file) && !['npm','npx'].includes(name)) throw new ToolError('Use a direct workspace command instead of a nested shell or batch file.');
  if (fileCommands.has(name)) {
    for (const operand of args) {
      if (operand.startsWith('-')) continue;
      checkedTarget(context.projectRoot, directory, operand);
    }
    return { file: process.execPath, args: [worker, context.projectRoot, name, ...args] };
  }
  const executable = /^[a-zA-Z0-9_][a-zA-Z0-9_.+-]*$/.test(file) ? file : checkedTarget(context.projectRoot, directory, file);
  for (const argument of args) {
    const operand = argument.startsWith('-') && argument.includes('=') ? argument.slice(argument.indexOf('=')+1) : argument;
    if (/(^|[\\/])\.\.([\\/]|$)|^[\\/]|^[a-zA-Z]:|(?:^|[\\/])\.(?:env|git)(?:[.\\/]|$)/i.test(operand)) throw new ToolError('Use workspace-relative command arguments.');
    if (/[\\/]/.test(operand) && !/^https?:\/\//i.test(operand)) checkedTarget(context.projectRoot, directory, operand);
  }
  if (windows && ['npm','npx'].includes(name)) {
    const cli = path.join(path.dirname(process.execPath),'node_modules','npm','bin',name+'-cli.js');
    if (!existsSync(cli)) throw new ToolError('The npm CLI beside Node.js is unavailable.');
    return {file:process.execPath,args:[cli,...args]};
  }
  return { file: name==='node' ? process.execPath : executable, args };
}

type Invocation = {file:string; args:string[]};
type Active = {root:string; chatId:string; controller:AbortController; result:Promise<CommandResult>};
export class LocalCommands {
  private active = new Map<string,Active>();
  private uncertain = new Set<string>();
  private closing = false;
  constructor(private options: ShellOptions) {}
  private id(context:ToolContext) { return JSON.stringify([key(path.resolve(context.projectRoot)),context.chatId,context.agentId]); }
  check(context:ToolContext,command?:string) {
    const {directory}=commandDirectory(context.projectRoot,context.commandCwd);
    if(command!==undefined)localInvocation(context,directory,command);
    return directory;
  }
  run(context:ToolContext,command:string,timeout?:number,beforeRun?:()=>Promise<void>,afterRun?:(result:CommandResult)=>Promise<void>) {
    return this.dispatch(context,directory=>localInvocation(context,directory,command),timeout,beforeRun,afterRun);
  }
  python(context:ToolContext,source:string,timeout?:number) {
    return this.dispatch(context,()=>({file:windows?'python.exe':'python3',args:['-c',source]}),timeout);
  }
  git(root:string,file:string,args:string[],limit:number,signal?:AbortSignal) {
    const {directory}=commandDirectory(root);
    return spawnLocal({file,args},directory,limit,15000,signal);
  }
  private dispatch(context:ToolContext, invocation:(directory:string)=>Invocation, timeout=this.options.defaultTimeoutMs, beforeRun?:()=>Promise<void>, afterRun?:(result:CommandResult)=>Promise<void>) {
    const id=this.id(context),root=key(path.resolve(context.projectRoot));
    if(this.closing || this.uncertain.has(root))throw new ToolError('Command cleanup or shutdown is pending.');
    if(this.active.has(id)||this.active.size>=this.options.maxSessions)throw new ToolError('A workspace command is already pending.','CONFLICT');
    const controller=new AbortController(),signal=context.signal?AbortSignal.any([context.signal,controller.signal]):controller.signal;
    const result=(async():Promise<CommandResult>=>{
      let outcome:CommandResult;
      try {
        const initial=commandDirectory(context.projectRoot,context.commandCwd);
        invocation(initial.directory);
        signal.throwIfAborted();
        await beforeRun?.();
        await context.prepareCommand?.();
        signal.throwIfAborted();
        const ready=commandDirectory(context.projectRoot,context.commandCwd);
        if(initial.stamp!==ready.stamp)throw new ToolError('Workspace directory changed before command launch.');
        invocation(ready.directory);
        context.beforeCommand?.();
        signal.throwIfAborted();
        if(ready.stamp!==commandDirectory(context.projectRoot,context.commandCwd).stamp)throw new ToolError('Workspace directory changed at command launch.');
        outcome=await spawnLocal(invocation(ready.directory),ready.directory,this.options.maxOutputBytes,Math.min(timeout,this.options.maxTimeoutMs),signal,context.onOutput);
      } catch(error) {
        outcome={status:'not_started',output:'',error:error instanceof Error?error.message:'Command dispatch failed.'};
      }
      if(outcome.uncertain)this.uncertain.add(root);
      await afterRun?.(outcome);
      return outcome;
    })().finally(()=>this.active.delete(id));
    this.active.set(id,{root,chatId:context.chatId,controller,result});
    return result;
  }
  async closeContext(context:ToolContext) {
    await this.active.get(this.id(context))?.result;
    this.assertCleanup(key(path.resolve(context.projectRoot)));
  }
  async removeScope(root:string,chatId?:string) {
    const target=key(path.resolve(root));
    this.assertCleanup(target);
    if([...this.active.values()].some(item=>item.root===target&&(!chatId||item.chatId===chatId)))throw new ToolError('A workspace command is still running.','CONFLICT');
  }
  private assertCleanup(root:string) {
    if(this.uncertain.has(root))throw new ToolError('Command termination could not be confirmed. Inspect workspace processes before restarting.','SANDBOX_CLEANUP_FAILED');
  }
  async dispose() {
    this.closing=true;
    const pending=[...this.active.values()];
    for(const item of pending)item.controller.abort();
    await Promise.all(pending.map(item=>item.result));
    for(const root of this.uncertain)this.assertCleanup(root);
  }
}

function spawnLocal({file,args}:Invocation,cwd:string,limit:number,timeout:number,signal?:AbortSignal,onOutput?:(text:string)=>void):Promise<CommandResult> {
  if(signal?.aborted)return Promise.resolve({output:'',status:'not_started',cancelled:true});
  return new Promise(resolve=>{
    const child=spawn(file,args,{cwd,env:childEnvironment(),stdio:['ignore','pipe','pipe'],windowsHide:true,detached:!windows});
    let output='',bytes=0,truncated=false,done=false,spawned=false,cancelled=false,timedOut=false,cleanupFailed=false;
    let cleanupDeadline:ReturnType<typeof setTimeout>|undefined;
    const finish=(result:CommandResult)=>{
      if(done)return;
      done=true;clearTimeout(timer);clearTimeout(cleanupDeadline);signal?.removeEventListener('abort',abort);
      resolve({truncated,...result});
    };
    const stop=(isCancelled:boolean)=>{
      if(done||cancelled||timedOut)return;
      cancelled=isCancelled;timedOut=!isCancelled;
      cleanupDeadline=setTimeout(()=>{
        child.stdout.destroy();child.stderr.destroy();
        finish({output,truncated,cancelled,timedOut,uncertain:true,error:'Command termination could not be confirmed.'});
      },5000);
      if(!child.pid)return;
      if(windows) {
        const taskkill=path.join(process.env.SystemRoot??'C:\\Windows','System32','taskkill.exe');
        execFile(taskkill,['/pid',String(child.pid),'/t','/f'],{timeout:3500,windowsHide:true},error=>{if(error&&child.exitCode===null){cleanupFailed=true;child.kill();}});
      } else {
        try { process.kill(-child.pid,'SIGKILL'); }
        catch(error) { if((error as NodeJS.ErrnoException).code!=='ESRCH')cleanupFailed=true; }
      }
    };
    const abort=()=>stop(true);
    const timer=setTimeout(()=>stop(false),timeout);
    const collect=(chunk:Buffer)=>{
      if(done)return;
      const text=chunk.subarray(0,Math.max(0,limit-bytes)).toString('utf8');
      truncated||=bytes+chunk.length>limit;bytes+=chunk.length;output+=text;
      if(text)try{onOutput?.(text);}catch{/* Output consumers cannot orphan a command. */}
    };
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    child.once('spawn',()=>{spawned=true;if(signal?.aborted)abort();});
    child.once('error',()=>finish({output,uncertain:spawned,...(!spawned?{status:'not_started'}:{}),error:'Command could not be started or controlled.'}));
    child.once('exit',()=>{
      if(windows||!child.pid||cancelled||timedOut)return;
      try { process.kill(-child.pid,0); cleanupFailed=true; process.kill(-child.pid,'SIGKILL'); }
      catch(error) { if((error as NodeJS.ErrnoException).code!=='ESRCH')cleanupFailed=true; }
    });
    child.once('close',(exitCode,termination)=>{
      if(cancelled||timedOut)finish({output,cancelled,timedOut,uncertain:cleanupFailed,error:cancelled?'Command cancelled. Completed effects were not rolled back.':'Command timed out. Completed effects were not rolled back.'});
      else if(cleanupFailed||termination)finish({output,uncertain:true,error:'Command exited with an unexpected termination or background process.'});
      else finish({output,...(exitCode!==null?{exitCode}:{})});
    });
  });
}
