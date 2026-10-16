import {lstatSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import type {NativeBindPolicy} from './native-bind-policy.js';
const relative=z.string().refine(value=>Buffer.byteLength(value,'utf8')<=1024&&!/[\uD800-\uDFFF]/u.test(value)&&value.split('/').length<=64&&(!value||value.split('/').every(part=>part.length<=240&&part!=='.'&&part!=='..'&&!!part&&!/[\\:\x00-\x1f<>"|?*]/.test(part)&&!/[. ]$/.test(part)&&!/^(?:con|conin\$|conout\$|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\..*)?$/i.test(part))));
export const nativeTargetSchema=z.object({root:z.enum(['state','config','control']),relative,kind:z.enum(['file','directory','sqlite']),mode:z.enum(['existing','create'])}).strict().refine(value=>(!!value.relative||value.kind==='directory'&&value.mode==='existing')&&(value.kind!=='sqlite'||value.relative.endsWith('.sqlite')));
export const nativeTargetsSchema=z.array(nativeTargetSchema).min(1).max(8).refine(values=>new Set(values.map(value=>value.root+':'+value.relative.toLowerCase())).size===values.length);
export type NativeTarget=z.infer<typeof nativeTargetSchema>;
/** Trusted internal paths only; metadata requests never accept a UI/model path. */
export function privateTarget(policy:NativeBindPolicy,filename:string,creating=false,kind?:NativeTarget['kind']):NativeTarget|undefined {
 const selected=Object.entries(policy.roots).filter(([,root])=>filename===root||filename.startsWith(root+path.sep)||path.sep==='\\'&&filename.startsWith(root+'/')).sort((a,b)=>b[1].length-a[1].length)[0];
 if(!selected||selected[0]==='workspace')return undefined;
 const [root,directory]=selected;let observed:ReturnType<typeof lstatSync>|undefined;
 try{observed=lstatSync(filename);}catch(error){if(!creating||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 return nativeTargetSchema.parse({root,relative:path.relative(directory,filename).split(path.sep).join('/'),kind:kind??(observed?.isDirectory()?'directory':filename.endsWith('.sqlite')?'sqlite':'file'),mode:observed?'existing':'create'});
}
