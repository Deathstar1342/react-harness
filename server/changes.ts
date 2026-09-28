import { randomUUID } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import type { ChangePreview, FileChange, FileChangeSummary, ProjectChanges, ToolService } from '../shared/types.js';
import { Store } from './store.js';
import { Runtime } from './runtime.js';

const conflict = (message: string) => Object.assign(new Error(message),{statusCode:409});
const summary = ({before: _before,after: _after,...item}: FileChange): FileChangeSummary => item;
const DIFF_LIMIT = 200_000;
export function boundedDiff(filename: string, before: string, after: string, created = false, removed = false): string {
  if (Buffer.byteLength(before) + Buffer.byteLength(after) > DIFF_LIMIT) throw new Error('Diff exceeds the 200 KB review limit. Inspect this file with an external editor; undo is unavailable here.');
  const diff = createTwoFilesPatch(created ? '/dev/null' : filename,removed ? '/dev/null' : filename,before,after,'','',{context:3,timeout:1000});
  if (!diff || Buffer.byteLength(diff) > DIFF_LIMIT) throw new Error('Diff exceeds the review limit. Inspect this file with an external editor; undo is unavailable here.');
  return diff;
}
export class Changes {
  private previews = new Map<string,{projectId:string;changeId:string;hash:string;expires:number}>();
  constructor(private store: Store, private tools: ToolService, private runtime: Runtime) {}
  async list(projectId: string): Promise<ProjectChanges> {
    const root = this.store.project(projectId).path;
    const result = await this.tools.execute({projectRoot:root,chatId:'changes',agentId:'changes'},{name:'git_status',args:{}});
    const history = this.store.fileChanges(projectId);
    return {git:result.ok ? result.data as ProjectChanges['git'] : [],...(!result.ok ? {gitError:result.output} : {}),history:history.slice(0,100),historyTruncated:history.length>100};
  }
  async diff(projectId: string, path: string): Promise<{diff:string}> {
    const root = this.store.project(projectId).path;
    const context = {projectRoot:root,chatId:'changes',agentId:'changes'};
    // Status validates literal paths and distinguishes untracked files from deletions.
    const status = await this.tools.execute(context,{name:'git_status',args:{}});
    if (!status.ok) throw new Error(status.output);
    const entry = (status.data as ProjectChanges['git']).find(item=>item.path === path);
    if (!entry) throw conflict('File is no longer in the current Git changes; refresh');
    if (entry.status === '??') {
      const file = await this.tools.read(root,path);
      return {diff:boundedDiff(path,'',file.content,true)};
    }
    const sections: string[] = [];
    for (const filename of [entry.originalPath,path].filter((name):name is string=>!!name)) {
      const result = await this.tools.execute(context,{name:'git_diff',args:{path:filename}});
      if (!result.ok) throw new Error(result.output);
      sections.push(result.output);
    }
    const diff = sections.join('\n');
    if (Buffer.byteLength(diff)>DIFF_LIMIT) throw new Error('Git diff exceeds the 200 KB review limit. Inspect externally.');
    return {diff:diff || 'No textual Git diff available.'};
  }
  async preview(projectId: string, changeId: string): Promise<ChangePreview> {
    const root = this.store.project(projectId).path;
    const change = this.store.fileChange(projectId,changeId);
    const preview: ChangePreview = {change:summary(change),diff:'',undoDiff:'',expectedHash:null};
    try {
      preview.diff = boundedDiff(change.path,change.before.content,change.after.content,change.before.hash === null);
      preview.undoDiff = boundedDiff(change.path,change.after.content,change.before.content,false,change.before.hash === null);
      const current = await this.tools.read(root,change.path);
      preview.expectedHash = current.hash;
      if (change.status !== 'confirmed') preview.reason = `Undo unavailable: recorded state is ${change.status}. Uncertain actions are never retried.`;
      else if (current.hash !== change.after.hash) preview.reason = 'The file changed after this write. Later saved edits must be preserved.';
      else if (!this.tools.restore) preview.reason = 'This backend does not support safe undo.';
      else {
        for (const [token,item] of this.previews) if (item.expires<Date.now()) this.previews.delete(token);
        while (this.previews.size >= 200) this.previews.delete(this.previews.keys().next().value!);
        preview.previewToken = randomUUID();
        this.previews.set(preview.previewToken,{projectId,changeId,hash:current.hash!,expires:Date.now()+5*60_000});
      }
    } catch (error) { preview.reason = error instanceof Error ? error.message : 'Preview unavailable'; }
    return preview;
  }
  async undo(projectId: string, changeId: string, expectedHash: string, previewToken: string) {
    return this.runtime.exclusiveProjectEdit(projectId,async()=>{
      const root = this.store.project(projectId).path;
      const change = this.store.fileChange(projectId,changeId);
      const token = this.previews.get(previewToken);
      if (!token || token.projectId !== projectId || token.changeId !== changeId || token.hash !== expectedHash || token.expires<Date.now()) throw conflict('Undo preview expired or does not match. Preview this write again.');
      if (change.status !== 'confirmed' || expectedHash !== change.after.hash) throw conflict('This recorded write is no longer available for undo.');
      if (!this.tools.restore) throw new Error('Safe undo is unavailable');
      let claimed = false;
      try {
        const result = await this.tools.restore(root,change.path,change.before,expectedHash,()=>{
          this.store.transitionFileChange(change.id,'confirmed','undoing');
          claimed = true;
          this.previews.delete(previewToken);
        });
        if (!claimed) throw new Error('Restore did not claim its mutation');
        if (result.path !== change.path || result.hash !== change.before.hash || result.content !== change.before.content) throw new Error('Restore result did not match the recorded target');
        this.store.transaction(()=>{
          this.store.transitionFileChange(change.id,'undoing','undone');
          this.runtime.notifyFileChange(projectId,change.path,'undo');
          for (const chat of this.store.chats(projectId)) this.store.event(chat.id,'file_changed',{path:change.path,source:'undo',hash:result.hash});
        });
        return {ok:true};
      } catch (error) {
        if (claimed) {
          // An event listener can fail after COMMIT. Never downgrade a durable
          // completed undo or attempt the filesystem operation again.
          if (this.store.fileChange(projectId,change.id).status === 'undone') throw conflict('Undo completed, but a notification failed. Refresh all project chats before resuming.');
          this.store.transitionFileChange(change.id,'undoing','unknown');
          this.runtime.notifyFileChange(projectId,change.path,'undo');
          for (const chat of this.store.chats(projectId)) this.store.event(chat.id,'file_changed',{path:change.path,source:'undo'});
          throw conflict('Undo outcome is uncertain. It will not be retried. Inspect the file and recorded snapshots.');
        }
        throw error;
      }
    });
  }
}
