import path from 'node:path';
import {key, rootPathSync, ToolError} from './paths.js';

// Private capabilities are Symbols created by trusted backend code. No model,
// browser UUID or persisted PID can acquire/reuse another operation's lease.
const owners = new Map<string,{owner:symbol; depth:number}>();
export const mutationRootKey = (root:string) => {try{return key(rootPathSync(root));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return key(path.resolve(root));}};
export function assertMutationIdle(root:string, owner?:symbol) {
  const active=owners.get(mutationRootKey(root));
  if(active && active.owner!==owner)throw new ToolError('A project mutation is active. Wait for its observed outcome before changing this project.','CONFLICT');
}
export function reserveMutation(root:string, owner=Symbol('project mutation')) {
  assertMutationIdle(root,owner);
  const id=mutationRootKey(root),existing=owners.get(id);
  if(existing)existing.depth++;else owners.set(id,{owner,depth:1});
  let released=false;
  return {owner,release:()=>{if(released)return;released=true;const current=owners.get(id);if(current?.owner===owner && --current.depth===0)owners.delete(id);}};
}
