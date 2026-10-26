import {z} from 'zod';
import type {Store} from './store.js';
import {preparedSchema} from './worker-client.js';
import {parseNativeJSON} from './native-json.js';
import {nativePrivateUnit} from './native-storage.js';

export const PREVIEW_STATE_LIMITS={recordBytes:262144,runBytes:2097152,metadataBytes:16384,projectionBytes:16384,totalBytes:262144,records:64} as const;
const ident=z.string().min(1).max(200),hash=z.string().regex(/^[a-f0-9]{64}$/).nullable();
const recordSchema=z.strictObject({id:z.uuid(),projectId:z.uuid(),chatId:z.uuid(),frameId:ident,taskId:ident,generation:z.number().int().nonnegative(),modeVersion:z.number().int().nonnegative(),approvalMode:z.enum(['review','balanced','autonomous']),instructionsHash:hash,skillsHash:hash,rootIdentity:z.string().max(8192).nullable(),status:z.enum(['starting','running','completed','failed','not_started','interrupted','uncertain']),dispatched:z.union([z.literal(0),z.literal(1)]),cancellationRequested:z.union([z.literal(0),z.literal(1),z.null()]),action:z.literal('start_process'),port:z.number().int().min(1024).max(65535).refine(port=>port!==3128).nullable(),workerBinding:preparedSchema.nullable()});
export type PreviewProcessRecord=z.infer<typeof recordSchema>;
const projection=`json_object('id',json_extract(data,'$.id'),'projectId',json_extract(data,'$.projectId'),'chatId',json_extract(data,'$.chatId'),'frameId',json_extract(data,'$.frameId'),'taskId',json_extract(data,'$.taskId'),'generation',json_extract(data,'$.generation'),'modeVersion',json_extract(data,'$.modeVersion'),'approvalMode',json_extract(data,'$.approvalMode'),'instructionsHash',json_extract(data,'$.instructionsHash'),'skillsHash',json_extract(data,'$.skillsHash'),'rootIdentity',json_extract(data,'$.rootIdentity'),'status',json_extract(data,'$.status'),'dispatched',json_extract(data,'$.dispatched'),'cancellationRequested',json_extract(data,'$.cancellationRequested'),'action',json_extract(data,'$.action.name'),'port',json_extract(data,'$.action.args.previewPort'),'workerBinding',json_extract(data,'$.workerBinding'))`;
const safe=`CASE WHEN length(CAST(data AS BLOB))<=${PREVIEW_STATE_LIMITS.recordBytes} THEN json_valid(data) ELSE 0 END`;
function parse(value:unknown,max=PREVIEW_STATE_LIMITS.projectionBytes){if(typeof value!=='string'||Buffer.byteLength(value)>max)throw new Error('Preview evidence is unavailable or exceeds its bound');return parseNativeJSON(value,max);}
export function previewRecord(store:Store,id:string):PreviewProcessRecord {
  const row=store.db.prepare(`SELECT CASE WHEN ${safe} THEN ${projection} END AS data FROM state WHERE key=?`).get('process-job:'+z.uuid().parse(id));
  return recordSchema.parse(parse(row?.data));
}
export function previewRecords(store:Store,projectId:string):PreviewProcessRecord[] {
  z.uuid().parse(projectId);
  const rows=store.db.prepare(`WITH selected AS (SELECT CASE WHEN ${safe} THEN ${projection} END AS data FROM state
    WHERE key>='process-job:' AND key<'process-job;' AND CASE WHEN ${safe} THEN json_extract(data,'$.projectId')=? ELSE 1 END ORDER BY key LIMIT 65),
    bounded AS (SELECT data,SUM(length(CAST(data AS BLOB))) OVER(ROWS UNBOUNDED PRECEDING) AS total FROM selected)
    SELECT CASE WHEN total<=${PREVIEW_STATE_LIMITS.totalBytes} THEN data END AS data FROM bounded`).all(projectId);
  if(rows.length>64)throw new Error('Preview process catalog exceeds its bound');
  return rows.map(row=>recordSchema.parse(parse(row.data)));
}
export function previewProject(store:Store,projectId:string){
  const row=store.db.prepare(`SELECT CASE WHEN length(CAST(data AS BLOB))<=16384 THEN CASE WHEN json_valid(data) THEN json_object('id',json_extract(data,'$.id'),'path',json_extract(data,'$.path'),'removalError',CASE WHEN json_extract(data,'$.removalError') IS NULL THEN 0 ELSE 1 END) END END AS data FROM projects WHERE id=?`).get(z.uuid().parse(projectId));
  const project=z.strictObject({id:z.literal(projectId),path:z.string().min(1).max(4096),removalError:z.union([z.literal(0),z.literal(1)])}).parse(parse(row?.data));return project;
}
export function previewAuthority(store:Store,projectId:string,id:string){return nativePrivateUnit(()=>{
  const record=previewRecord(store,id),project=previewProject(store,projectId);
  const chatRow=store.db.prepare(`SELECT CASE WHEN length(CAST(data AS BLOB))<=16384 THEN CASE WHEN json_valid(data) THEN json_object('id',json_extract(data,'$.id'),'projectId',json_extract(data,'$.projectId'),'mode',json_extract(data,'$.mode'),'modeVersion',json_extract(data,'$.modeVersion'),'approvalMode',json_extract(data,'$.approvalMode')) END END AS data FROM chats WHERE id=? AND project_id=?`).get(record.chatId,projectId);
  const chat=z.strictObject({id:z.literal(record.chatId),projectId:z.literal(projectId),mode:z.literal('execute'),modeVersion:z.literal(record.modeVersion),approvalMode:z.literal(record.approvalMode)}).parse(parse(chatRow?.data));
  const row=store.db.prepare(`SELECT CASE WHEN length(CAST(data AS BLOB))<=2097152 THEN CASE WHEN json_valid(data) AND json_type(data,'$.frames')='array' AND json_array_length(data,'$.frames') BETWEEN 1 AND 64 AND json_type(data,'$.steering')='array' THEN json_object(
    'generation',json_extract(data,'$.generation'),'planOnly',json_extract(data,'$.planOnly'),'steering',json_array_length(data,'$.steering'),'instructionsHash',json_extract(data,'$.instructionsHash'),'skillsHash',json_extract(data,'$.skillsHash'),
    'taskId',json_extract(data,'$.frames[0].id'),'frameCount',(SELECT count(*) FROM json_each(data,'$.frames') f WHERE json_extract(f.value,'$.id')=?)) END END AS data FROM state WHERE key=?`).get(record.frameId,'run:'+record.chatId);
  z.strictObject({generation:z.literal(record.generation),planOnly:z.literal(0),steering:z.literal(0),instructionsHash:z.literal(record.instructionsHash),skillsHash:z.literal(record.skillsHash),taskId:z.literal(record.taskId),frameCount:z.literal(1)}).parse(parse(row?.data));
  if(record.projectId!==projectId)throw new Error('Preview process belongs to another project');
  return {record,project,chat};
});}
