import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, readdirSync, rmdirSync, unlinkSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeletionPreview, ProjectRemoval, ToolService } from '../shared/types.js';
import type { Config } from './config.js';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { WorkspaceLocations } from './workspace.js';
import { key } from './tools/paths.js';

const conflict = (message: string) => Object.assign(new Error(message),{statusCode:409});
const inside = (parent: string, child: string) => key(parent)===key(child) || key(child).startsWith(key(parent).replace(/[\\/]$/,'')+path.sep);
const overlap = (a: string,b: string) => inside(a,b) || inside(b,a);
function canonical(input: string): string {
  // Resolve existing ancestors as well: a configured directory need not exist yet.
  try { return realpathSync(input); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;
    const parent=path.dirname(input);
    if (parent===input) throw error;
    return path.join(canonical(parent),path.basename(input));
  }
}
function identity(input: string) {
  const info=lstatSync(input,{bigint:true});
  if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw conflict('Linked or special filesystem paths cannot be deleted here');
  return {stamp:`${info.dev}:${info.ino}:${info.birthtimeNs}`,directory:info.isDirectory(),dev:info.dev};
}
function ancestry(root: string) {
  const entries: string[]=[];
  for (let current=root;;current=path.dirname(current)) {
    const item=identity(current);
    if (!item.directory) throw conflict('Project path is no longer a directory');
    entries.push(`${current}:${item.stamp}`);
    if (path.dirname(current)===current) break;
  }
  if (key(realpathSync(root))!==key(root)) throw conflict('Project canonical path changed');
  return entries.join('\n');
}
function mounts(): string[] {
  if (process.platform!=='linux') return [];
  // A bind mount can share st_dev with its parent. Never recurse through it.
  return readFileSync('/proc/self/mountinfo','utf8').trim().split('\n').map(line=>line.split(' ')[4]!.replace(/\\([0-7]{3})/g,(_,oct:string)=>String.fromCharCode(parseInt(oct,8))));
}
interface Token { projectId:string; root:string; stamp:string; expires:number }
interface Entry { filename:string; stamp:string; directory:boolean }

/** One backend instance. No automatic retry: disk and SQLite cannot share a transaction. */
export class Removal {
  private tokens=new Map<string,Token>();
  constructor(private store:Store,private runtime:Runtime,private tools:ToolService,private config:Config,private locations:WorkspaceLocations,
    private cleanup:(projectId:string,chatIds:string[],wholeProject:boolean)=>void) {}

  private validate(projectId:string): {root:string;stamp:string} {
    const project=this.store.project(projectId),root=path.resolve(project.path);
    if (!path.isAbsolute(project.path) || root!==project.path) throw conflict('Registered project path is not canonical');
    const stamp=ancestry(root);
    const protectedTrees=[path.resolve(fileURLToPath(new URL('..',import.meta.url))),process.cwd(),this.config.dataDir,
      ...(this.store.filename===':memory:' ? [] : [path.dirname(path.resolve(this.store.filename))]),
      ...Object.values(this.config.promptFiles).map(file=>path.dirname(file!)),path.join(homedir(),'.config')];
    const protectedRoots=[path.parse(root).root,homedir(),this.locations.settings().workspaceRoot,this.locations.settings().defaultWorkspaceRoot];
    if (protectedRoots.some(item=>inside(root,canonical(path.resolve(item)))) || protectedTrees.some(item=>overlap(root,canonical(path.resolve(item))))) {
      throw conflict('Refusing deletion of a filesystem, home, workspace, application, configuration or database root');
    }
    if (this.store.projects().some(other=>other.id!==projectId && overlap(root,canonical(path.resolve(other.path))))) throw conflict('Project overlaps another registered project; remove that registration first');
    if (mounts().some(mount=>inside(root,mount))) throw conflict('Mounted filesystem roots cannot be deleted here');
    return {root,stamp};
  }

  preview(projectId:string): DeletionPreview {
    for (const [id,token] of this.tokens) if (token.expires<=Date.now()) this.tokens.delete(id);
    const {root,stamp}=this.validate(projectId),confirmationToken=randomUUID(),expires=Date.now()+300_000;
    while (this.tokens.size>=200) this.tokens.delete(this.tokens.keys().next().value!);
    this.tokens.set(confirmationToken,{projectId,root,stamp,expires});
    return {canonicalPath:root,confirmationToken,expiresAt:new Date(expires).toISOString()};
  }

  private scan(root:string): Entry[] {
    const result:Entry[]=[],rootDev=identity(root).dev;
    const visit=(filename:string,depth:number)=>{
      if (depth>128 || result.length>=100_000) throw conflict('Project exceeds the safe deletion scan limit; remove from app and manage files externally');
      const item=identity(filename);
      if (item.dev!==rootDev) throw conflict('Mounted filesystem paths cannot be deleted here');
      result.push({filename,stamp:item.stamp,directory:item.directory});
      if (item.directory) for (const child of readdirSync(filename)) visit(path.join(filename,child),depth+1);
    };
    visit(root,0);return result.reverse();
  }

  async project(projectId:string,request:ProjectRemoval) {
    return this.runtime.exclusiveRemoval(projectId,async()=>{
      const project=this.store.project(projectId);
      if (!this.tools.removeScope) throw conflict('Tool service cannot safely remove project resources');
      let confirmed:{token:Token;entries:Entry[]}|undefined;
      if (request.mode==='disk') {
        const token=this.tokens.get(request.confirmationToken);
        if (!token || token.projectId!==projectId || token.expires<=Date.now() || token.root!==request.canonicalPath) throw conflict('Deletion confirmation expired or does not match this project');
        const current=this.validate(projectId);
        if (current.root!==token.root || current.stamp!==token.stamp) throw conflict('Project path identity changed; request a new confirmation');
        confirmed={token,entries:this.scan(current.root)};
        if (this.validate(projectId).stamp!==token.stamp) throw conflict('Project path changed before deletion');
      }
      // This callback is synchronous: no new lease, request or runtime launch can enter
      // between the final lease/identity validation and the mutation in this process.
      return this.tools.removeScope(project.path,undefined,()=>{
        if (request.mode==='disk') {
          const {token,entries}=confirmed!;
          const current={root:token.root};
          this.tokens.delete(request.confirmationToken);
          this.store.removalError(projectId,'File deletion was started. Its outcome may be partial; review the folder, then explicitly retry or remove from app only.');
          try {
            for (const entry of entries) {
              if (ancestry(current.root)!==token.stamp) throw conflict('Project path changed during deletion');
              // Check every remaining parent, not only the target: reject directory-to-link substitution.
              for(let parent=path.dirname(entry.filename);inside(current.root,parent);parent=path.dirname(parent)) identity(parent);
              const item=identity(entry.filename);
              if (item.stamp!==entry.stamp || item.directory!==entry.directory) throw conflict('A project entry changed during deletion');
              if (entry.directory) rmdirSync(entry.filename); else unlinkSync(entry.filename);
            }
          } catch (error) {
            const message=`File deletion incomplete: ${(error as Error).message}. App records were retained. Review remaining files and retry with a new confirmation, or remove from app only.`;
            this.store.removalError(projectId,message);throw conflict(message);
          }
        }
        const chatIds=this.store.chats(projectId).map(chat=>chat.id);
        this.store.deleteProject(projectId);
        this.runtime.forgetChats(chatIds);
        this.cleanup(projectId,chatIds,true);
        for (const [id,token] of this.tokens) if (token.projectId===projectId) this.tokens.delete(id);
        return {ok:true};
      });
    });
  }

  async chat(chatId:string) {
    const chat=this.store.chat(chatId),project=this.store.project(chat.projectId);
    return this.runtime.exclusiveRemoval(project.id,async()=>{
      if (!this.tools.removeScope) throw conflict('Tool service cannot safely remove chat resources');
      return this.tools.removeScope(project.path,chatId,()=>{
        this.store.deleteChat(chatId);this.runtime.forgetChats([chatId]);this.cleanup(project.id,[chatId],false);return {ok:true};
      });
    });
  }
}
