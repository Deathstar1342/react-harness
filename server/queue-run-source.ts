import {z} from 'zod';
import {parseNativeJSON} from './native-json.js';
const int=z.number().safe().int().nonnegative(),hash=z.string().regex(/^[a-f0-9]{64}$/);
const idle=z.strictObject({frames:z.array(z.never()).max(0),steering:z.array(z.string().max(100000)).max(256),planOnly:z.boolean(),steps:int,generation:int,humanMessageIds:z.array(z.uuid()).min(1).max(4096),objective:z.string().max(100000).optional(),instructionsHash:hash.nullable().optional(),instructionTargets:z.array(z.string().max(4096)).max(100).optional(),skillsHash:hash.optional(),queueClaim:z.strictObject({id:z.uuid(),projectId:z.uuid(),taskId:z.uuid()}).optional()});
export function validQueueIdleRun(raw:unknown){if(typeof raw!=='string'||Buffer.byteLength(raw)>1100000)return false;try{const s=idle.parse(parseNativeJSON(raw,1100000));return s.steering.length===0&&new Set(s.humanMessageIds).size===s.humanMessageIds.length;}catch{return false;}}
