import type {FileSnapshot, PlanStepRef, ReviewReplan} from '../shared/types.js';
import type {AssignmentEvidence} from './assignment-evidence.js';
import type {Store} from './store.js';
import {assertNativeJSON} from './native-json.js';
import {toolRegistry} from './tool-registry.js';
import {hash, inAssignedPath, safeRelative} from './tools/paths.js';

export const reviewLimits = {
  receipts:100, rows:24, files:8, document:32*1024, working:128*1024, patch:16*1024, ms:500,
  event:1024*1024, summary:2000,
} as const;

interface ReviewSource {
  id: string;
  role: 'coder'|'critic';
  origin: string|null;
  ids?: number[];
}

type ReceiptStatus = 'succeeded'|'failed'|'uncertain'|'unavailable';

export interface ReviewReceipt {
  id: number;
  role: ReviewSource['role'];
  tool?: string;
  path?: string;
  destination?: string;
  status: ReceiptStatus;
  check?: AssignmentEvidence['checks'][number]['status'];
  directory?: boolean;
  baseDigest?: string|null;
  report?: 'passed'|'failed'|'error'|'unavailable';
  skipped?: number;
  exit?: number;
  digest?: string|null;
  changeId?: string;
  commandId?: string;
  destinationDigest?: string;
  legacy?: boolean;
  outside?: boolean;
}

export interface ReviewEvidence {
  receipts: ReviewReceipt[];
  incomplete: boolean;
}

const digestPattern = /^[0-9a-f]{64}$/;
const validity = 'json_valid(e.data) AND length(CAST(e.data AS BLOB)) <= ?';

// Both halves of the native result must agree. Compare inside SQLite so raw output,
// source snapshots and shell arguments never become an automatic prompt projection.
function receiptQuery(store: Store) {
  return store.db.prepare(
    "WITH event AS MATERIALIZED (SELECT data FROM events e WHERE id=? AND chat_id=? AND type='tool' AND " + validity + ")," +
    " matched AS MATERIALIZED (SELECT e.data FROM event e JOIN messages m ON m.id=json_extract(e.data,'$.messageId') AND m.chat_id=?" +
    " JOIN state n ON n.key='native:result:' || m.chat_id || ':' || ? || ':' || json_extract(m.data,'$.metadata.toolCallId')" +
    " WHERE length(CAST(m.data AS BLOB))<=? AND json_valid(m.data) AND json_extract(m.data,'$.role')='tool'" +
    " AND json_extract(m.data,'$.metadata.agentId')=? AND json_extract(e.data,'$.agentId')=?" +
    " AND json_extract(m.data,'$.metadata.commandId')=json_extract(e.data,'$.commandId')" +
    " AND json_extract(m.data,'$.metadata.name')=json_extract(e.data,'$.action.name')" +
    " AND json_type(e.data,'$.result.ok') IN ('true','false')" +
    " AND json_type(e.data,'$.result.ok')=json_type(m.data,'$.metadata.ok')" +
    " AND length(CAST(n.data AS BLOB))<=? AND json_extract(e.data,'$.result')=n.data" +
    " AND NOT EXISTS (SELECT 1 FROM json_tree(e.data) WHERE typeof(key)='text' GROUP BY parent,key HAVING count(*)>1)" +
    " AND ((json_type(e.data,'$.reviewReceipt') IS NULL) OR" +
    " (json_extract(e.data,'$.reviewReceipt.version')=1 AND length(json_extract(e.data,'$.reviewReceipt.origin'))=64" +
    " AND (? IS NULL OR json_extract(e.data,'$.reviewReceipt.origin')=?)" +
    " AND json_extract(e.data,'$.reviewReceipt.callId')=json_extract(m.data,'$.metadata.toolCallId'))))" +
    " SELECT CASE WHEN length(json_extract(data,'$.action.name'))<=64 THEN json_extract(data,'$.action.name') END AS tool," +
    " CASE WHEN length(CAST(json_extract(data,'$.action.args.path') AS BLOB))<=1024 THEN json_extract(data,'$.action.args.path') END AS path," +
    " CASE WHEN length(CAST(json_extract(data,'$.action.args.destination') AS BLOB))<=1024 THEN json_extract(data,'$.action.args.destination') END AS destination," +
    " json_type(data,'$.action.args.path') AS pathType, json_type(data,'$.action.args.destination') AS destinationType," +
    " json_type(data,'$.result.data')='array' AS arrayResult," +
    " json_type(data,'$.action.args.baseHash') AS baseHashType," +
    " CASE WHEN length(json_extract(data,'$.action.args.baseHash'))=64 THEN json_extract(data,'$.action.args.baseHash') END AS baseHash," +
    " json_type(data,'$.result.ok') AS ok, json_type(data,'$.reviewReceipt') IS NULL AS legacy," +
    " CASE WHEN length(json_extract(data,'$.commandId'))<=64 THEN json_extract(data,'$.commandId') END AS changeId," +
    " CASE WHEN length(json_extract(data,'$.result.data.path'))<=1024 THEN json_extract(data,'$.result.data.path') END AS resultPath," +
    " CASE WHEN length(json_extract(data,'$.result.data.hash'))=64 THEN json_extract(data,'$.result.data.hash') END AS digest," +
    " json_type(data,'$.result.data.hash') AS hashType," +
    " CASE WHEN json_type(data,'$.result.data.exitCode')='integer' THEN json_extract(data,'$.result.data.exitCode') END AS exit," +
    " CASE WHEN json_extract(data,'$.result.data.testReport.status') IN ('passed','failed','error','unavailable')" +
    " THEN json_extract(data,'$.result.data.testReport.status') END AS report," +
    " (SELECT count(*) FROM json_each(data,'$.result.data.testReport.tests') WHERE" +
    " CASE WHEN type='object' THEN json_extract(value,'$.status')='skipped' ELSE 0 END) AS skipped," +
    " CASE WHEN json_extract(data,'$.result.data.snapshots[1].path')=json_extract(data,'$.action.args.destination')" +
    " AND length(json_extract(data,'$.result.data.snapshots[1].hash'))=64" +
    " THEN json_extract(data,'$.result.data.snapshots[1].hash') END AS destinationDigest," +
    " json_extract(data,'$.result.data.status')='not_started' AS notStarted," +
    " (json_type(data,'$.result.data.uncertain')='true' OR json_type(data,'$.result.data.cancelled')='true'" +
    " OR json_type(data,'$.result.data.timedOut')='true' OR json_type(data,'$.result.data.recoveryRequired')='true'" +
    " OR json_extract(data,'$.result.data.mutation')='uncertain' OR json_extract(data,'$.result.data.state')='uncertain'" +
    " OR (json_type(data,'$.result.data.shellReset')='true' AND json_type(data,'$.result.data.error')='text')) AS uncertain" +
    " FROM matched",
  );
}

function relative(value: unknown) {
  if (typeof value !== 'string') return;
  try { return safeRelative(value); } catch { return; }
}

export function reviewEvidence(
  store: Store, chatId: string, sources: ReviewSource[], scope: string[]|undefined, assignment?: AssignmentEvidence, rowLimit?: number,
): ReviewEvidence {
  const receipts: ReviewReceipt[] = [];
  const read = receiptQuery(store);
  const started = performance.now();
  const seen = new Set<number>();
  let incomplete = false;
  const checks = new Map((assignment?.checks ?? []).map(check=>[check.eventId,check.status]));
  let remaining = rowLimit ?? sources.length*reviewLimits.receipts;
  for (const {id:frameId,role,origin,ids = []} of sources.toReversed()) {
    if (!Array.isArray(ids) || ids.length > reviewLimits.receipts) {
      incomplete = true;
      continue;
    }
    const count = Math.min(remaining,ids.length);
    remaining -= count;
    if (count < ids.length) incomplete = true;
    for (const id of ids.slice(ids.length-count)) {
      if (performance.now()-started >= reviewLimits.ms) return {receipts:receipts.sort((a,b)=>a.id-b.id),incomplete:true};
      if (!Number.isSafeInteger(id) || id < 1 || seen.has(id)) {
        incomplete = true;
        continue;
      }
      seen.add(id);
      const missing: ReviewReceipt = {id,role,status:'unavailable',check:checks.get(id)};
      const row = read.get(id,chatId,reviewLimits.event,chatId,frameId,128*1024,frameId,frameId,reviewLimits.event,origin,origin);
      const tool = typeof row?.tool === 'string' ? toolRegistry.get(row.tool) : undefined;
      if (!tool || !tool.roles.includes(role) || tool.kind !== 'workspace' || !row) {
        receipts.push(missing);
        continue;
      }
      const path = relative(row.path), destination = relative(row.destination);
      const outside = !!scope?.length && [path,destination].some(item=>item && !scope.some(prefix=>inAssignedPath(item,prefix)));
      const directory = tool.name==='list_files' && row.arrayResult===1;
      const rootDirectory = directory && (row.path === undefined || row.path === null || row.path === '' || row.path === '.');
      const badTarget = row.pathType && !path && !rootDirectory || row.destinationType && !destination;
      if (badTarget || outside) {
        receipts.push({...missing,tool:tool.name,outside});
        continue;
      }
      const exit = typeof row.exit === 'number' ? row.exit : undefined;
      const report = typeof row.report === 'string' ? row.report as ReviewReceipt['report'] : undefined;
      const legacy = row.legacy === 1;
      const status: ReceiptStatus = row.notStarted === 1 ? 'unavailable' : row.uncertain === 1 || tool.command && exit === undefined
        ? 'uncertain'
        : row.ok === 'true' && (!tool.command || exit === 0) ? 'succeeded' : 'failed';
      const digest = relative(row.resultPath) === path && path
        ? typeof row.digest === 'string' && digestPattern.test(row.digest) ? row.digest : row.hashType === 'null' ? null : undefined
        : undefined;
      const changeId = !legacy && tool.fileMutation && typeof row.changeId === 'string' ? row.changeId : undefined;
      const destinationDigest = typeof row.destinationDigest === 'string' && digestPattern.test(row.destinationDigest) ? row.destinationDigest : undefined;
      const baseDigest = typeof row.baseHash === 'string' && digestPattern.test(row.baseHash) ? row.baseHash : row.baseHashType==='null' ? null : undefined;
      receipts.push({...missing,tool:tool.name,path,destination,digest,baseDigest,changeId,commandId:typeof row.changeId==='string'?row.changeId:undefined,destinationDigest,status,legacy,report,exit,directory,
        skipped:typeof row.skipped === 'number' && row.skipped > 0 ? row.skipped : undefined});
    }
  }
  return {receipts:receipts.sort((a,b)=>a.id-b.id),incomplete};
}

export interface SnapshotPair {before: FileSnapshot; after: FileSnapshot}

function snapshot(value: unknown, filename: string): value is FileSnapshot {
  if (!value || typeof value !== 'object') return false;
  const {path,content,hash:digest} = value as FileSnapshot;
  return path === filename && typeof content === 'string' && !content.includes('\0') &&
    (digest === null ? content === '' : typeof digest === 'string' && digest === hash(content));
}

export function reviewChange(store: Store, projectId: string, chatId: string, receipt: ReviewReceipt) {
  if (receipt.status !== 'succeeded' || !receipt.changeId || !receipt.path || receipt.digest === undefined) return;
  const row = store.db.prepare(
    "SELECT snapshots FROM file_changes WHERE id=? AND project_id=? AND status='confirmed'" +
    " AND json_valid(summary) AND json_extract(summary,'$.chatId')=? AND json_extract(summary,'$.path')=?" +
    " AND length(CAST(snapshots AS BLOB))<=? AND json_valid(snapshots)",
  ).get(receipt.changeId,projectId,chatId,receipt.path,reviewLimits.document);
  if (typeof row?.snapshots !== 'string') return;
  const pairs: SnapshotPair[] = [];
  try { assertNativeJSON(row.snapshots,reviewLimits.document); } catch { return; }
  const record: unknown = JSON.parse(row.snapshots);
  if (record === null || typeof record !== 'object') return;
  const {before,after,destination} = record as Partial<{before:FileSnapshot;after:FileSnapshot;destination:SnapshotPair}>;
  if (!snapshot(before,receipt.path) || !snapshot(after,receipt.path) || after.hash !== receipt.digest || before.hash !== receipt.baseDigest) return;
  pairs.push({before,after});
  if (receipt.destination) {
    if (!snapshot(destination?.before,receipt.destination) || !snapshot(destination?.after,receipt.destination) || destination.after.hash !== receipt.destinationDigest || destination.before.hash !== null) return;
    pairs.push(destination);
  } else if (destination) return;
  return {pairs,bytes:Buffer.byteLength(row.snapshots)};
}

export function isReviewRead(receipt: ReviewReceipt) {
  return receipt.status === 'succeeded' && typeof receipt.digest === 'string' &&
    (receipt.tool === 'read_file' || receipt.tool === 'read_file_range');
}

export function isReplanReceipt(receipt: ReviewReceipt, currentFiles: Set<number>, currentCheck: boolean) {
  if (receipt.legacy || receipt.outside) return false;
  if (receipt.status === 'failed') return currentCheck && receipt.check==='failed' &&
    (receipt.report==='failed' || typeof receipt.exit==='number' && receipt.exit!==0);
  return receipt.status==='succeeded' && (currentFiles.has(receipt.id) || currentCheck && receipt.check==='passed');
}

export function reviewReplan(args: Record<string,unknown>): ReviewReplan|undefined {
  return args.replan as ReviewReplan|undefined;
}

export function samePlanStep(left: PlanStepRef|undefined, right: PlanStepRef|undefined) {
  return left?.planId === right?.planId && left?.planVersion === right?.planVersion &&
    left?.phaseId === right?.phaseId && left?.stepId === right?.stepId;
}
