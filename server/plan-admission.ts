import type { Action, PlanTaskCheck, PlanTaskDependency, ToolResult } from '../shared/types.js';
import { taskIntent, taskLimits, type StoredPlan, type StoredPlanTask } from './plan-tasks.js';
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
  checks: PlanTaskCheck[];
  task?: {objective: string; dependsOn?: PlanTaskDependency[]};
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

export const stepKey = (phaseId: string, stepId: string) => JSON.stringify([phaseId, stepId]);

export function prepareTaskProposal(previous: StoredPlan, proposed: StoredPlan, entries: PlanStepAdmission[] | undefined) {
  const prior = new Map(previous.phases.flatMap(phase => phase.steps.map(step => [step.id, {phase,step}] as const)));
  const nodes = new Set(proposed.phases.flatMap(phase => phase.steps.map(step => stepKey(phase.id,step.id))));
  const updates = new Set<string>();
  const taskEntries = new Map<string, PlanStepAdmission>();
  for (const entry of entries ?? []) {
    if (!entry.task) continue;
    const key = stepKey(entry.phaseId, entry.stepId);
    if (!nodes.has(key) || taskEntries.has(key)) throw new Error('Task metadata must identify an exact proposed phase and step once.');
    if (entry.task.dependsOn?.some(dep => {
      const target = stepKey(dep.phaseId,dep.stepId);
      return target === key || !nodes.has(target);
    })) throw new Error('Task dependencies must refer to other steps in the proposed plan.');
    taskEntries.set(key,entry);
  }
  for (const phase of proposed.phases) for (const step of phase.steps) {
    const old = prior.get(step.id);
    const key = stepKey(phase.id,step.id);
    const entry = taskEntries.get(key);
    const oldTask = old?.step.task;
    const sameStep = old?.phase.id === phase.id && old.phase.title === phase.title && old.step.title === step.title;
    if (oldTask && !sameStep && !entry) throw new Error('Supply fresh task metadata when changing the definition of an annotated step.');
    if (entry?.task && (!sameStep || !oldTask || taskIntent({...entry,...entry.task}) !== taskIntent(oldTask))) updates.add(key);
    else if (oldTask) step.task = oldTask;
  }
  return updates;
}

function requiredEvidence(previous: StoredPlan, proposed: StoredPlan, updates: Set<string>) {
  const prior = new Map(previous.phases.map(phase => [phase.id, {
    title: phase.title, steps: new Map(phase.steps.map(step => [step.id,step.title])),
  }]));
  const required = new Set<string>(), present = new Set<string>();
  for (const phase of proposed.phases) {
    const before = prior.get(phase.id);
    if (!phase.steps.length && (!before || before.steps.size || before.title !== phase.title)) {
      throw new Error('New or revised phases need at least one step. Discuss outlines in ordinary chat.');
    }
    for (const step of phase.steps) {
      const key = stepKey(phase.id, step.id);
      present.add(key);
      if (!previous.id || before?.title !== phase.title || before.steps.get(step.id) !== step.title || updates.has(key)) required.add(key);
    }
  }
  return {required, present};
}

export async function prepareAdmission(
  root: ReconnaissanceRoot,
  previous: StoredPlan,
  proposed: StoredPlan,
  steps: PlanStepAdmission[] | undefined,
  updates: Set<string>,
  frameId: string,
  lookup: (callId: string) => { observation: PlanObservation; result: ToolResult } | undefined,
  signal: AbortSignal,
): Promise<{checkFiles: () => void; tasks: Map<string, StoredPlanTask>}> {
  const end = performance.now() + reconnaissanceLimits.evidenceMs;
  return withinReconnaissance(reconnaissanceLimits.evidenceMs, signal, async budget => {
    const {required, present} = requiredEvidence(previous, proposed, updates);
    const tasks = new Map<string, StoredPlanTask>();
    if (!steps?.length || steps.length < required.size) {
      throw new Error('Give every new or revised step source or new-file evidence and an observable check. For a removal or reorder, cite a retained step.');
    }
    const paths = new Map<string, {evidence: PlanObservation; content?: string}>();
    let references = 0;
    let remainingBytes: number = reconnaissanceLimits.evidenceBytes;
    let empty: string | undefined;
    for (const step of steps) {
      const key = stepKey(step.phaseId, step.stepId);
      if (!present.delete(key)) throw new Error('Each evidence entry must identify an exact proposed phase and step once.');
      required.delete(key);
      if (!step.sources.length && !step.newFiles.length) throw new Error('Inspect a relevant source or explicitly identify a proposed new file.');
      if (!step.sources.length) empty ??= await emptyPlanningRoot(root, budget);
      const stepPaths = new Map<string, 'file' | 'absent'>();
      const task: StoredPlanTask | undefined = updates.has(key) && step.task ? {
        version:1, admittedAtPlanVersion:(previous.version ?? 0)+1,
        objective:step.task.objective, ...(step.task.dependsOn?.length ? {dependsOn:step.task.dependsOn} : {}),
        sources:[], newFiles:[], checks:step.checks,
      } : undefined;
      if (task && step.sources.length + step.newFiles.length > taskLimits.references) {
        throw new Error('A task can store up to eight source or new-file references.');
      }

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
          if (task) {
            const receipt = {path:filename,callId:reference.callId,frameId};
            if (kind === 'absent') {
              if (task.newFiles.some(file => file.path === filename)) throw new Error('Duplicate planned-new task reference.');
              task.newFiles.push(receipt);
            } else {
              const startLine = read.startLine ?? 1;
              const lineCount = disclosed.match(/[^\n]*\n|[^\n]+$/g)?.length ?? 0;
              if (task.sources.some(source => source.path === filename && source.startLine === startLine && source.lineCount === lineCount && source.symbol === reference.symbol)) {
                throw new Error('Duplicate task source span.');
              }
              task.sources.push({...receipt,hash:entry.observation.hash!,startLine,lineCount,...(reference.symbol ? {symbol:reference.symbol} : {})});
            }
          }
          stepPaths.set(filename, kind);
        }
      }
      if (!step.checks.length || step.checks.some(check => !stepPaths.has(check.target))) {
        throw new Error('Each step needs a test or inspection with an expected result and a source or proposed-file target in that step.');
      }
      if (task) tasks.set(key,task);
    }

    if (required.size) throw new Error('Some new or revised steps have no evidence. Cite every changed step or split the revision.');

    const checkFiles = () => {
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
    return {checkFiles,tasks};
  });
}
