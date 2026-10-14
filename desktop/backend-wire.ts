import { z } from 'zod';
const hex=z.string().regex(/^[a-f0-9]{64}$/);
export const launchSchema=z.object({home:z.string().min(1).max(4096),mode:z.enum(['existing','initialize','migrate']),legacyRoot:z.string().max(4096).optional(),key:hex,token:hex}).strict();
export const descriptorSchema=z.object({address:z.string().url(),identity:z.object({protocol:z.literal('abyssus-backend-v1'),instanceId:z.string().uuid(),profileId:z.string().uuid(),pid:z.number().int().positive(),platform:z.literal('linux'),state:z.literal('ready')}).strict(),checks:z.array(z.object({name:z.string(),ok:z.boolean(),message:z.string()})).max(16)}).strict();
export const failureSchema=z.object({error:z.string().max(512),checks:z.array(z.object({name:z.string(),ok:z.boolean(),message:z.string()})).max(16).optional()}).strict();
export function loopbackAddress(raw:string):string {
  const url=new URL(raw);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Invalid private backend address');
  return url.origin;
}
