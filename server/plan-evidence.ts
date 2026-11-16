import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {parseNativeJSON} from './native-json.js';
import {taskLimits} from './plan-tasks.js';
import {reconnaissancePath} from './repository-reconnaissance.js';

type Outline = Record<string, unknown>;
const object = (value:unknown):Outline|undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Outline : undefined;
const bytes = (value:string) => Buffer.byteLength(value);
const nonblank = (max:number) => z.string().max(max).refine(value=>bytes(value)<=max && !!value.trim());
const relative = nonblank(1024).refine(value=>{
  try {return reconnaissancePath(value)===value;} catch {return false;}
});
const positive = z.number().int().positive();
const receipt = {path:relative,callId:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),frameId:nonblank(200)};
const taskSchema = z.strictObject({
  version:z.literal(1),
  admittedAtPlanVersion:positive,
  objective:nonblank(600),
  dependsOn:z.array(z.strictObject({phaseId:nonblank(200),stepId:nonblank(200)})).max(4).optional(),
  sources:z.array(z.strictObject({
    ...receipt,hash:z.string().regex(/^[a-f0-9]{64}$/),
    startLine:positive.max(2_000_001),lineCount:z.number().int().nonnegative().max(256*1024),
    symbol:z.string().regex(/^[A-Za-z_$][\w$]{0,79}$/).optional(),
  })).max(taskLimits.references),
  newFiles:z.array(z.strictObject(receipt)).max(taskLimits.references),
  checks:z.array(z.strictObject({method:z.enum(['test','inspection']),target:relative,expected:nonblank(600)})).min(1).max(4),
});

function validTask(value:unknown, planVersion:unknown) {
  const parsed=taskSchema.safeParse(value);
  if(!parsed.success || typeof planVersion!=='number' || !Number.isSafeInteger(planVersion)) return false;
  const task=parsed.data, references=task.sources.length+task.newFiles.length;
  if(!references || references>taskLimits.references || task.admittedAtPlanVersion>planVersion) return false;
  const deps=task.dependsOn ?? [];
  if(new Set(deps.map(dep=>JSON.stringify([dep.phaseId,dep.stepId]))).size!==deps.length) return false;
  const hashes=new Map<string,string>();
  const spans=new Set<string>();
  for(const source of task.sources) {
    const span=JSON.stringify([source.path,source.startLine,source.lineCount,source.symbol]);
    if(spans.has(span) || hashes.has(source.path) && hashes.get(source.path)!==source.hash) return false;
    hashes.set(source.path,source.hash);
    spans.add(span);
  }
  const newFiles=new Set(task.newFiles.map(file=>file.path));
  return newFiles.size===task.newFiles.length && !task.newFiles.some(file=>hashes.has(file.path)) &&
    task.checks.every(check=>hashes.has(check.target)||newFiles.has(check.target));
}

// The empty mandatory v1 object is smaller than every valid annotation. This
// bounds each extra comma and property name even before the SQL metadata count.
const smallestTask=bytes('{"version":1,"admittedAtPlanVersion":1,"objective":"","sources":[],"newFiles":[],"checks":[]}');
const wrapperBytes=bytes(',"task":');
const envelopeOverhead=Math.floor(taskLimits.planBytes/smallestTask)*wrapperBytes;

/** This deterministic SQL callback is reached only after the raw, per-task,
 * aggregate and outline limits. Return the stripped legacy evidence to callers. */
export function installPlanEvidenceReader(db:DatabaseSync) {
  db.function('plan_evidence_outline',{deterministic:true},(raw,rawLimit,outlineLimit,expectedTasks)=>{
    if(typeof raw!=='string'||typeof rawLimit!=='number'||typeof outlineLimit!=='number'||typeof expectedTasks!=='number') return null;
    try {
      const outline=object(parseNativeJSON(raw,rawLimit));
      if(!outline) return null;
      // SQLite compacts JSON values when measuring them. Annotated rows use
      // the Store's exact encoding so whitespace cannot evade either limit.
      if(expectedTasks && JSON.stringify(outline)!==raw) return null;
      let stripped=0;
      for(const phase of Array.isArray(outline.phases)?outline.phases:[]) {
        const steps=object(phase)?.steps;
        for(const entry of Array.isArray(steps)?steps:[]) {
          const step=object(entry);
          if(!step || !Object.hasOwn(step,'task')) continue;
          if(!validTask(step.task,outline.version)) return null;
          delete step.task;
          stripped++;
        }
      }
      if(stripped!==expectedTasks) return null;
      const encoded=stripped?JSON.stringify(outline):raw;
      return bytes(encoded)<=outlineLimit?encoded:null;
    } catch {return null;}
  });
}

type PlanObservation =
  | {status:'missing'|'unavailable';outline?:undefined}
  | {status:'observed';outline:Outline};

export function readPlanEvidence(db:DatabaseSync,chatId:string,outlineLimit:number):PlanObservation {
  const rawLimit=outlineLimit+taskLimits.planBytes+envelopeOverhead;
  // Discount only actual step annotations and their fixed Store field wrapper.
  const row=db.prepare(`
    WITH source(raw) AS MATERIALIZED (
      SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB))<=?
        THEN CASE WHEN json_valid(data) THEN data END END
      FROM state WHERE key=?
    ), tasks(kind,bytes) AS MATERIALIZED (
      SELECT field.type,length(CAST(field.value AS BLOB))
      FROM source,
        json_each(CASE WHEN json_type(raw,'$.phases')='array' THEN json_extract(raw,'$.phases') END) phase,
        json_each(CASE WHEN phase.type='object' THEN
          CASE WHEN json_type(phase.value,'$.steps')='array' THEN json_extract(phase.value,'$.steps') END END) step,
        json_each(CASE WHEN step.type='object' THEN step.value END) field
      WHERE field.key='task'
    ), task_budget AS (
      SELECT count(*) AS count,coalesce(sum(bytes),0) AS total,
        coalesce(sum(CASE WHEN kind='object' AND bytes BETWEEN ? AND ? THEN 0 ELSE 1 END),0) AS invalid
      FROM tasks
    )
    SELECT CASE WHEN raw IS NOT NULL AND invalid=0 AND total<=?
      AND length(CAST(raw AS BLOB))<=?+total+count*?
      THEN plan_evidence_outline(raw,?,?,count) END AS outline
    FROM source CROSS JOIN task_budget
  `).get(rawLimit,'plan:'+chatId,smallestTask,taskLimits.bytes,taskLimits.planBytes,
    outlineLimit,wrapperBytes,rawLimit,outlineLimit);
  if(!row) return {status:'missing'};
  if(typeof row.outline!=='string') return {status:'unavailable'};
  return {status:'observed',outline:JSON.parse(row.outline) as Outline};
}
