import path from 'node:path';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { applicationHome, installationRoot } from '../locations.js';
import { key, ToolError, isProtected } from './paths.js';
import { helperProtectedPaths } from '../helper-paths.js';

const inside=(parent:string,child:string)=>key(parent)===key(child)||key(child).startsWith(key(parent).replace(/[\\/]$/,'')+path.sep);
const overlap=(a:string,b:string)=>inside(a,b)||inside(b,a);
function canonical(input:string):string {
  try{return realpathSync(input);}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    const parent=path.dirname(input);
    if(parent===input)throw error;
    return path.join(canonical(parent),path.basename(input));
  }
}
export interface WorkspacePolicyOptions {home:string;protectedPaths:string[];projects:()=>string[]}
export class WorkspacePolicy {
  private policy:WorkspacePolicyOptions={home:applicationHome(),protectedPaths:[],projects:()=>[]};
  configure(policy:WorkspacePolicyOptions){this.policy=policy;}
  validateRoot(input:string):string {
    const root=canonical(path.resolve(input));
    if(root.split(path.sep).some(isProtected))throw new ToolError('Credential and Git metadata directories cannot be selected as project roots.','UNSAFE_PROJECT');
    const protectedPaths=[this.policy.home,installationRoot,path.dirname(path.dirname(realpathSync(process.execPath))),...this.policy.protectedPaths,...(process.platform==='linux'?helperProtectedPaths:[])].map(p=>canonical(path.resolve(p)));
    if([path.parse(root).root,canonical(homedir())].some(p=>inside(root,p))||protectedPaths.some(p=>overlap(root,p)))throw new ToolError('Project overlaps application, configuration, home or state paths. Select a separate project folder.','UNSAFE_PROJECT');
    if(this.policy.projects().map(p=>canonical(path.resolve(p))).some(p=>p!==root&&overlap(root,p)))throw new ToolError('Project overlaps another registered project. Select separate project folders.','UNSAFE_PROJECT');
    return root;
  }
}
