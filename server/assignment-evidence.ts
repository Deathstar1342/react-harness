import { createHash } from 'node:crypto';
import type { Action, ToolResult } from '../shared/types.js';
import { commandEvent, isCommand } from './command-events.js';
import type { Frame } from './runtime.js';
import type { ScopeSnapshot, VerificationSnapshot } from './verification-scope.js';
import { definitionFor } from './tool-registry.js';

interface Coverage { id: string; seen: number; required: number; }
interface Check { key: string; eventId: number; status: 'passed'|'failed'|'missing_report'|'coverage_reduced'|'stale'|'scope_unknown'; coverage: Coverage[]; scopeDigest?: string; scopeReason?: string; }
export interface AssignmentEvidence { checks: Check[]; uncertainEventIds: number[]; overflow: boolean; }
const limit = 100;
// Arguments identify a requested check, NOT its observed coverage. Actual report
// testcase identities/multiplicity below independently constrain resolution.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Called only for a runtime-recorded result, within its clone/COMMIT transition. */
export function recordAssignmentEvidence(frame: Frame, action: Action, result: ToolResult, eventId: number, snapshot?: VerificationSnapshot) {
  if (frame.role !== 'coder') return;
  const evidence = frame.acceptanceEvidence ??= { checks: [], uncertainEventIds: [], overflow: false };
  const data = (result.data && typeof result.data === 'object' ? result.data : {}) as Record<string, unknown>;
  const notStarted = data.status === 'not_started' || data.mutation === 'not_started';
  const command = isCommand(action) ? commandEvent(frame, {id: String(eventId), action}, result) : undefined;
  if (!notStarted && (data.uncertain === true || data.mutation === 'uncertain' || command && ['uncertain','interrupted'].includes(command.status))) {
    if (evidence.uncertainEventIds.length < limit) evidence.uncertainEventIds.push(eventId);
    else evidence.overflow = true;
  }
  if (!notStarted && definitionFor(action.name).effect !== 'read' && action.name !== 'run_tests') {
    for (const check of evidence.checks) if (check.status === 'passed') check.status = 'stale';
  }
  if (action.name !== 'run_tests' || notStarted) return;
  const stable = snapshot?.bindingValid && snapshot.before.status==='observed' && snapshot.after.status==='observed' && snapshot.before.digest===snapshot.after.digest;
  // A test command may modify source too. Independent checks can coexist only
  // across matching observed scope, without a mutation or unknown interval.
  for(const check of evidence.checks)if(check.status==='passed' && (!stable || check.scopeDigest!==snapshot?.before.digest))check.status='stale';
  const key = createHash('sha256').update(canonical(action)).digest('hex');
  const report = data.testReport as {status?: string; tests?: {status?: string}[]}|undefined;
  const tests = Array.isArray(report?.tests) ? report.tests : [];
  const current = new Map<string,{seen:number;required:number;passed:number}>();
  for (const test of tests as {name?:unknown;classname?:unknown;status?:string}[]) {
    if (typeof test?.name !== 'string' || test.classname !== undefined && typeof test.classname !== 'string') { evidence.overflow = true; continue; }
    const id = createHash('sha256').update(JSON.stringify([test.classname ?? '',test.name])).digest('hex');
    const value = current.get(id) ?? {seen:0,required:0,passed:0};
    value.seen++;if(test.status !== 'skipped')value.required++;if(test.status === 'passed')value.passed++;
    current.set(id,value);
  }
  const index = evidence.checks.findIndex(item=>item.key === key);
  const previous = index === -1 ? [] : evidence.checks[index].coverage;
  const preserved = previous.every(item=>{const now=current.get(item.id);return now && now.seen>=item.seen && now.passed>=item.required;});
  const coverage = new Map(previous.map(item=>[item.id,item]));
  for(const [id,item] of current) {const old=coverage.get(id);coverage.set(id,{id,seen:Math.max(item.seen,old?.seen??0),required:Math.max(item.required,old?.required??0)});}
  // Global coverage bound prevents large reports/long repair histories from
  // turning private frame metadata into an unbounded second transcript.
  const otherCoverage = evidence.checks.reduce((sum,check,i)=>sum+(i===index?0:check.coverage.length),0);
  if(otherCoverage+coverage.size>10000)evidence.overflow=true;
  const complete = result.ok && command?.status === 'completed' && report?.status === 'passed' &&
    tests.some(test=>test?.status === 'passed') && tests.every(test=>test?.status === 'passed' || test?.status === 'skipped');
  const failed = command?.status === 'failed' || report?.status === 'failed' || tests.some(test=>test?.status === 'failed' || test?.status === 'error');
  const check: Check = {key, eventId, status: complete ? !preserved ? 'coverage_reduced' : !stable ? 'scope_unknown' : 'passed' : failed ? 'failed' : 'missing_report',coverage:[...coverage.values()].slice(0,Math.max(0,10000-otherCoverage)),
    scopeDigest:stable?snapshot?.after.digest:undefined,scopeReason:stable?undefined:snapshot?.before.reason??snapshot?.after.reason??'Inspected scope changed during verification or its task binding is stale; inspect changes and verify the final source.'};
  if (index !== -1) evidence.checks[index] = check;
  else if (evidence.checks.length < limit) evidence.checks.push(check);
  else evidence.overflow = true;
}

export function assignmentBlockers(frame: Frame): string[] {
  const evidence = frame.acceptanceEvidence;
  if (!evidence) return [];
  return [
    ...(evidence.overflow ? ['Assignment evidence exceeded its bounded ledger; acceptance is unverified.'] : []),
    ...evidence.uncertainEventIds.map(id=>`Tool event ${id}: effect uncertain or interrupted after dispatch; a critic verdict or replay cannot reconcile it.`),
    ...evidence.checks.filter(check=>check.status !== 'passed').map(check=>`Verification event ${check.eventId}: ${check.status === 'failed' ? 'failed verification' : check.status === 'stale' ? 'verification predates a later possible mutation' : check.status === 'coverage_reduced' ? 'observed testcase coverage was removed, reduced or skipped' : check.status==='scope_unknown' ? `verification scope is unverified: ${check.scopeReason}` : 'incomplete test-report evidence (command exit and report are separate)'}. Requires a complete matching check in this assignment; a narrower check cannot replace it.`),
  ];
}

/** Recheck observed source at the completion-review boundary; never revalidate
 * a stale check without a new actual test result. */
export function refreshAssignmentEvidence(frame: Frame, snapshot: ScopeSnapshot) {
  for(const check of frame.acceptanceEvidence?.checks??[]) {
    if(check.status==='passed' && (snapshot.status!=='observed' || check.scopeDigest!==snapshot.digest)) {
      check.status='stale';check.scopeReason=snapshot.reason;
    }
  }
}
