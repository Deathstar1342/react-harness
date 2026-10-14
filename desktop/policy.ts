import path from 'node:path';
import { z } from 'zod';
export const desktopOrigin='abyssus://app';
export const distributionSchema=z.string().regex(/^(Ubuntu(?:-[0-9.]+)?|Debian)$/).max(80);
export const environmentSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('linux')}).strict(),
  z.object({kind:z.literal('wsl'),distribution:distributionSchema}).strict(),
]);
export const linuxPath=z.string().min(2).max(4096).refine(v=>v.startsWith('/')&&!/[\x00-\x1f\x7f\\]/.test(v)&&!v.split('/').includes('..'),'Choose an absolute Linux path without parent traversal');
export const startSchema=z.object({environment:environmentSchema,home:linuxPath,mode:z.enum(['existing','initialize','migrate']),legacyRoot:linuxPath.optional()}).strict()
  .refine(v=>(v.mode==='migrate')===Boolean(v.legacyRoot),'Migration requires exactly one explicit legacy root');
export function isDesktopURL(raw:string):boolean {
  try {const u=new URL(raw);return u.protocol==='abyssus:'&&u.host==='app'&&!u.username&&!u.password&&!u.port;}catch{return false;}
}
export function validateSender(event:{sender:unknown;senderFrame:{url:string;parent:unknown}|null},contents:unknown) {
  if(event.sender!==contents||!event.senderFrame||event.senderFrame!==(contents as {mainFrame?:unknown}|undefined)?.mainFrame||event.senderFrame.parent!==null||!isDesktopURL(event.senderFrame.url))throw new Error('Untrusted desktop sender');
}
export function parseDistributions(output:string):string[] {
  return output.replaceAll('\0','').split(/\r?\n/).flatMap(line=>{
    const match=line.trim().replace(/^\*\s*/,'').match(/^(\S+)\s+.+\s+2\s*$/);
    return match&&distributionSchema.safeParse(match[1]).success?[match[1]]:[];
  });
}
export function pickerPath(raw:string,distribution?:string):string {
  let result=raw;
  if(distribution) {
    distributionSchema.parse(distribution);
    const match=raw.match(/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)$/i);
    if(!match||match[1].toLowerCase()!==distribution.toLowerCase())throw new Error('Choose a folder inside the selected WSL distribution using its Linux files shortcut. Windows drive folders are unsupported.');
    result=match[2].replaceAll('\\','/');
  }
  linuxPath.parse(result);
  result=path.posix.normalize(result);
  if(['/mnt','/media'].some(base=>result===base||result.startsWith(base+'/')))throw new Error('Mounted Windows folders are unsupported. Choose a Linux project folder.');
  return result;
}
export function assetPath(root:string,raw:string):string {
  const u=new URL(raw);if(!isDesktopURL(raw))throw new Error('Invalid asset origin');
  const pathname=decodeURIComponent(u.pathname);
  if(pathname.includes('\\')||pathname.includes('\0')||pathname.split('/').includes('..'))throw new Error('Invalid asset path');
  const resolved=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!resolved.startsWith(path.resolve(root)+path.sep))throw new Error('Asset outside application');
  return resolved;
}
export const contentSecurityPolicy="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
