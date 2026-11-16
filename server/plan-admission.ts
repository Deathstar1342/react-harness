import type { Action, ToolResult } from '../shared/types.js';
import {
  assertEmptyPlanningRoot, assertReconnaissanceRoot, declarationNames, emptyPlanningRoot,
  observePlanningPath, readPlanningFile, reconnaissanceLimits, reconnaissancePath,
  withinReconnaissance, type PathObservation, type ReconnaissanceRoot,
} from './repository-reconnaissance.js';
import { hash } from './tools/paths.js';

export interface PlanEvidenceReference { path: string; callId: string; symbol?: string; excerpt?: string }
export interface PlanStepAdmission {
  phaseId: string;
  stepId: string;
  sources: PlanEvidenceReference[];
  newFiles: Pick<PlanEvidenceReference, 'path' | 'callId'>[];
  checks: {method: 'test' | 'inspection'; target: string; expected: string}[];
}
export interface PlanObservation {
  binding: string;
  rootIdentity: string;
  callId: string;
  path: string;
  observation: PathObservation;
  kind: 'read_file' | 'read_file_range' | 'inspect_new_plan_path';
  hash?: string;
  at: number;
}

interface NativeRead { path?: string; hash?: string | null; content?: string; state?: string; startLine?: number; totalLines?: number; nextLine?: number | null }

function completeRead(action: Action, result: ToolResult, relative: string): NativeRead | undefined {
  if (!result.ok || !result.data || typeof result.data !== 'object' || !nativeResultFits(result)) return;
  const data = result.data as NativeRead;
  if (data.path !== relative || typeof data.content !== 'string' || data.content !== result.output ||
      typeof data.hash !== 'string' || !/^[a-f0-9]{64}$/.test(data.hash)) return;
  if (action.name === 'read_file_range') {
    const start = Number(action.args.startLine), count = Number(action.args.count);
    const returned = data.content.match(/[^\n]*\n|[^\n]+$/g)?.length ?? 0;
    if (data.startLine !== start || !Number.isSafeInteger(data.totalLines) || returned < 1 ||
        returned !== Math.min(count, data.totalLines! - start + 1) ||
        data.nextLine !== (start + returned <= data.totalLines! ? start + returned : null)) return;
  } else if (hash(data.content) !== data.hash) return;
  return data;
}

export const nativeResultFits = (result: ToolResult, serialized = JSON.stringify(result)) => Buffer.byteLength(serialized) <= 120_000;
export const planningRead = (name: string): name is PlanObservation['kind'] =>
  name === 'read_file' || name === 'read_file_range' || name === 'inspect_new_plan_path';

export function planObservation(
  action: Action, result: ToolResult, callId: string, binding: string,
  root: ReconnaissanceRoot, before: PathObservation,
): PlanObservation | undefined {
  if (!planningRead(action.name)) return;
  const relative = reconnaissancePath(String(action.args.path));
  const after = observePlanningPath(root, relative);
  if (after.state !== before.state || after.stamp !== before.stamp) return;
  if (action.name === 'inspect_new_plan_path') {
    if (!result.ok || !nativeResultFits(result) || (result.data as NativeRead | undefined)?.path !== relative ||
        (result.data as NativeRead).state !== 'absent' || after.state !== 'absent') return;
    return {kind: action.name, path: relative, callId, binding, rootIdentity: root.identity, observation: after, at: Date.now()};
  }
  const data = completeRead(action, result, relative);
  if (!data || after.state !== 'file' || after.bytes > reconnaissanceLimits.evidenceBytes) return;
  return {kind: action.name, path: relative, callId, binding, rootIdentity: root.identity, observation: after, hash: data.hash!, at: Date.now()};
}

export async function prepareAdmission(
  root: ReconnaissanceRoot,
  phases: {id: string; steps: {id: string}[]}[],
  steps: PlanStepAdmission[] | undefined,
  lookup: (callId: string) => { observation: PlanObservation; result: ToolResult } | undefined,
  signal: AbortSignal,
): Promise<() => void> {
  const end = performance.now() + reconnaissanceLimits.evidenceMs;
  return withinReconnaissance(reconnaissanceLimits.evidenceMs, signal, async budget => {
    const expected = phases.flatMap(phase => phase.steps.map(step => JSON.stringify([phase.id, step.id])));
    if (!expected.length || phases.some(phase => !phase.steps.length) || !steps || steps.length !== expected.length) {
      throw new Error('Give every planned step source or new-file evidence and an observable check. Use ordinary chat to discuss a plan outline.');
    }

    const remaining = new Set(expected);
    const paths = new Map<string, {evidence: PlanObservation; content?: string}>();
    let references = 0;
    let remainingBytes: number = reconnaissanceLimits.evidenceBytes;
    let empty: string | undefined;
    for (const step of steps) {
      if (!remaining.delete(JSON.stringify([step.phaseId, step.stepId]))) {
        throw new Error('Planning evidence must identify each exact phase and step once.');
      }
      if (!step.sources.length && !step.newFiles.length) throw new Error('Inspect a relevant source or explicitly identify a proposed new file.');
      if (!step.sources.length) empty ??= await emptyPlanningRoot(root, budget);
      const stepPaths = new Map<string, 'file' | 'absent'>();

      for (const [kind, inputs] of [['file', step.sources], ['absent', step.newFiles]] as const) {
        for (const reference of inputs as PlanEvidenceReference[]) {
          budget.throwIfAborted();
          if (++references > reconnaissanceLimits.references) throw new Error('Planning evidence exceeds 16 references. Split the plan revision.');
          const filename = reconnaissancePath(reference.path);
          if (filename !== reference.path || stepPaths.has(filename) && stepPaths.get(filename) !== kind) {
            throw new Error('Use canonical project-relative paths and classify each file consistently.');
          }
          const entry = lookup(reference.callId);
          if (!entry || entry.observation.path !== filename || entry.observation.observation.state !== kind ||
              Date.now() - entry.observation.at > 600_000) {
            throw new Error('Get a fresh native ' + (kind === 'file' ? 'read' : 'inspect_new_plan_path result') + ' for ' + JSON.stringify(filename) + ' in this run.');
          }
          const current = paths.get(filename);
          let content = current?.content;
          if (current) {
            if (current.evidence.observation.stamp !== entry.observation.observation.stamp || current.evidence.hash !== entry.observation.hash) {
              throw new Error('Conflicting file versions in planning evidence for ' + JSON.stringify(filename) + '. Inspect the current version.');
            }
          } else {
            if (paths.size === reconnaissanceLimits.paths) throw new Error('Planning evidence exceeds eight paths. Split the plan revision.');
            const live = observePlanningPath(root, filename);
            if (live.state !== kind || live.stamp !== entry.observation.observation.stamp) {
              throw new Error('Planning evidence for ' + JSON.stringify(filename) + ' is stale. Inspect the current path.');
            }
            if (kind === 'file') {
              if (live.bytes > remainingBytes) throw new Error('Planning file validation exceeds 256 KiB. Use smaller source files or split the plan revision.');
              const checked = await readPlanningFile(root, filename, live, remainingBytes, budget);
              if (entry.observation.hash !== checked.hash) throw new Error('Planning evidence for ' + JSON.stringify(filename) + ' changed. Read it again.');
              remainingBytes -= live.bytes;
              content = checked.content;
            }
            paths.set(filename, {evidence: entry.observation, content});
          }
          const read = entry.result.data as NativeRead;
          const disclosed = read.content ?? '';
          if (content !== undefined) {
            const lines = disclosed.match(/[^\n]*\n|[^\n]+$/g) ?? [];
            const start = (read.startLine ?? 1) - 1;
            const expected = entry.observation.kind === 'read_file'
              ? content : (content.match(/[^\n]*\n|[^\n]+$/g) ?? []).slice(start, start + lines.length).join('');
            if (disclosed !== expected) {
              throw new Error('The delivered read no longer matches the source. Read the current file or range.');
            }
          }
          if (reference.symbol && !declarationNames(disclosed).includes(reference.symbol) ||
              reference.excerpt && !disclosed.includes(reference.excerpt)) {
            throw new Error('The requested declaration-like name or excerpt was outside the delivered source. Read the relevant lines of ' + JSON.stringify(filename) + '.');
          }
          stepPaths.set(filename, kind);
        }
      }
      if (!step.checks.length || step.checks.some(check => !stepPaths.has(check.target))) {
        throw new Error('Each step needs a test or inspection with an expected result and a source or proposed-file target in that step.');
      }
    }

    return () => {
      signal.throwIfAborted();
      assertReconnaissanceRoot(root);
      if (empty !== undefined) assertEmptyPlanningRoot(root, empty);
      for (const [filename, {evidence}] of paths) {
        if (performance.now() >= end) throw new Error('Planning evidence expired before commit. Refresh the inspection.');
        const current = observePlanningPath(root, filename);
        if (current.state !== evidence.observation.state || current.stamp !== evidence.observation.stamp) {
          throw new Error('Planning evidence changed before commit. Inspect ' + JSON.stringify(filename) + ' again.');
        }
      }
      if (performance.now() >= end) throw new Error('Planning evidence expired before commit. Refresh the inspection.');
    };
  });
}
