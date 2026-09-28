import type { FileSnapshot, ProjectChanges, ToolService } from '../shared/types.js';
import type { Store } from './store.js';

export class Changes {
  constructor(private store: Store, private tools: ToolService) {}
  async list(projectId: string): Promise<ProjectChanges> {
    const project = this.store.project(projectId);
    const result = await this.tools.execute({projectRoot:project.path,chatId:'changes-view',agentId:'changes-view'},{name:'git_status',args:{}});
    return {files:result.ok ? result.data as ProjectChanges['files'] : [], ...(result.ok ? {} : {gitError:result.output}),history:this.store.fileChanges(projectId)};
  }
  async preview(projectId: string, changeId: string) {
    const project = this.store.project(projectId), change = this.store.fileChange(projectId,changeId);
    const current = await this.tools.read(project.path,change.path);
    return {change,current,canUndo:change.status==='applied' && current.hash===change.after.hash};
  }
  async undo(projectId: string, changeId: string, baseHash: string): Promise<FileSnapshot> {
    const {change,current,canUndo} = await this.preview(projectId,changeId);
    if (!canUndo || current.hash!==baseHash) throw new Error('Undo conflict: this change was already undone, is uncertain, or the file has later edits. Refresh and review it manually.');
    // Recheck after asynchronous preview: only one request may claim this operation.
    if (this.store.fileChange(projectId,changeId).status!=='applied') throw new Error('Undo conflict: this change is already being processed.');
    const root = this.store.project(projectId).path;
    if (change.before.hash===null && !this.tools.remove) throw new Error('Undo of new files is unavailable.');
    this.store.changeStatus(projectId,changeId,'undoing');
    // An uncertain filesystem result is never replayed after a restart or error.
    const result = change.before.hash===null
      ? await this.tools.remove!(root,change.path,baseHash)
      : await this.tools.save(root,change.path,change.before.content,baseHash);
    this.store.changeStatus(projectId,changeId,'undone');
    return result;
  }
}
