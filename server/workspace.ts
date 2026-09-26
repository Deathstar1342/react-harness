import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, opendir, realpath, stat } from 'node:fs/promises';
import type { DirectoryListing, WorkspaceSettings } from '../shared/types.js';
import type { Store } from './store.js';

const stateKey = 'preferences:workspace';
const validPath = (value: string) => {
  if (!value || value.length > 4096 || value.includes('\0') || !path.isAbsolute(value)) throw new Error('Choose an absolute folder path');
  return path.resolve(value);
};

/** Human-facing directory selection. Model file tools remain project-confined. */
export class WorkspaceLocations {
  constructor(private store: Store, private defaultRoot: string) {}
  settings(): WorkspaceSettings {
    return {workspaceRoot:this.store.getState<string>(stateKey,this.defaultRoot),defaultWorkspaceRoot:this.defaultRoot};
  }
  async update(input: string): Promise<WorkspaceSettings> {
    let root = validPath(input);
    if (root === path.parse(root).root) throw new Error('Choose a workspace folder, not an entire drive or filesystem');
    try {
      if (!(await stat(root)).isDirectory()) throw new Error('Workspace path must be a folder');
      root = await realpath(root);
      if (root === path.parse(root).root) throw new Error('Choose a workspace folder, not an entire drive or filesystem');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.store.setState(stateKey,root);
    return this.settings();
  }
  async allocate(name: string): Promise<string> {
    const root = this.settings().workspaceRoot;
    await mkdir(root,{recursive:true});
    const canonicalRoot = await realpath(root);
    let slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80) || 'project';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(slug)) slug += '-project';
    for (let suffix=1;suffix<=10000;suffix++) {
      const candidate = path.join(canonicalRoot,slug+(suffix===1?'':`-${suffix}`));
      try {await mkdir(candidate);return candidate;}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;}
    }
    throw new Error('Too many projects with that name; choose a different name');
  }
  async browse(input?: string): Promise<DirectoryListing> {
    const directory = await realpath(validPath(input ?? homedir()));
    if (!(await stat(directory)).isDirectory()) throw new Error('Select a folder');
    const shortcuts = [{name:'Home',path:homedir()},{name:'Workspace',path:this.settings().workspaceRoot}];
    if (process.platform === 'win32') {
      const drives = await Promise.all(Array.from({length:26},async(_,i)=>{
        const drive = `${String.fromCharCode(65+i)}:\\`;
        try {return (await stat(drive)).isDirectory()?{name:drive,path:drive}:null;} catch {return null;}
      }));
      shortcuts.push(...drives.filter((drive): drive is {name:string;path:string}=>drive!==null));
    } else {
      shortcuts.push({name:'Filesystem',path:'/'});
      if (await stat('/mnt').then(info=>info.isDirectory()).catch(()=>false)) shortcuts.push({name:'Mounted drives',path:'/mnt'});
    }
    // Do not create the default workspace merely because someone browsed folders.
    const roots = (await Promise.all(shortcuts.map(async item=>(await stat(item.path).then(info=>info.isDirectory()).catch(()=>false))?item:null))).filter((item): item is {name:string;path:string}=>item!==null);
    const entries: DirectoryListing['entries'] = [];
    let count = 0, truncated = false;
    for await (const entry of await opendir(directory)) {
      if (++count > 10000) {truncated=true;break;}
      if (entry.name.startsWith('.') || entry.name.startsWith('$')) continue;
      if (entry.isDirectory() || entry.isSymbolicLink() && await stat(path.join(directory,entry.name)).then(info=>info.isDirectory()).catch(()=>false)) entries.push({name:entry.name,path:path.join(directory,entry.name)});
    }
    const parent = path.dirname(directory);
    return {path:directory,parentPath:parent===directory?null:parent,entries:entries.sort((a,b)=>a.name.localeCompare(b.name)),roots,truncated};
  }
}
