import type { AgentRole, Plan, PlanPhase, PlanStep, PlanStepRef, PlanTask, PlanTaskSource } from '../shared/types.js';

type Receipt = { callId: string; frameId: string };
export interface StoredPlanTask extends PlanTask {
  sources: (PlanTaskSource & Receipt & {hash: string})[];
  newFiles: ({path: string} & Receipt)[];
}
export interface StoredPlanStep extends PlanStep { task?: StoredPlanTask }
export interface StoredPlanPhase extends PlanPhase { steps: StoredPlanStep[] }
export interface StoredPlan extends Plan { phases: StoredPlanPhase[] }

export const taskLimits = { references: 8, bytes: 6144, planBytes: 64 * 1024 } as const;

export function assertTaskBudget(plan: StoredPlan) {
  let bytes = 0;
  for (const phase of plan.phases) for (const {task} of phase.steps) {
    if (!task) continue;
    const size = Buffer.byteLength(JSON.stringify(task));
    if (size > taskLimits.bytes) throw new Error('Task metadata exceeds 6,144 bytes. Use fewer references or shorter checks.');
    bytes += size;
    if (bytes > taskLimits.planBytes) throw new Error('Plan task metadata exceeds 64 KiB. Use a smaller plan or fewer annotated steps.');
  }
}

export const taskDefinition = (task: StoredPlanTask | undefined) => task && [
  task.version, task.objective, task.dependsOn?.map(dep => [dep.phaseId, dep.stepId]) ?? [],
  task.sources.map(source => [source.path, source.callId, source.frameId, source.hash, source.startLine, source.lineCount, source.symbol]),
  task.newFiles.map(file => [file.path, file.callId, file.frameId]),
  task.checks.map(check => [check.method, check.target, check.expected]),
];

export function taskIntent(task: Pick<PlanTask, 'objective'|'dependsOn'|'checks'> & {
  sources: (Pick<PlanTaskSource,'path'|'symbol'> & {callId: string})[];
  newFiles: {path: string; callId: string}[];
}) {
  return JSON.stringify([
    task.objective, task.dependsOn?.map(dep => [dep.phaseId,dep.stepId]) ?? [],
    task.sources.map(source => [source.path, source.callId, source.symbol]), task.newFiles.map(file => [file.path,file.callId]),
    task.checks.map(check => [check.method,check.target,check.expected]),
  ]);
}

function publicTask(task: StoredPlanTask): PlanTask {
  return {
    version: task.version, admittedAtPlanVersion: task.admittedAtPlanVersion, objective: task.objective,
    ...(task.dependsOn?.length ? {dependsOn:task.dependsOn} : {}),
    sources: task.sources.map(({path,startLine,lineCount,symbol}) => ({path,startLine,lineCount,...(symbol ? {symbol} : {})})),
    newFiles: task.newFiles.map(({path}) => ({path})), checks: task.checks,
  };
}

export function publicPlan(plan: StoredPlan): Plan {
  return {
    id: plan.id, version: plan.version,
    phases: plan.phases.map(phase => ({...phase, steps: phase.steps.map(({task,...step}) => ({
      ...step, ...(task ? {task: publicTask(task)} : {}),
    }))})),
  };
}

type OutlineRow =
  | {phaseId: string; title: string}
  | {phaseId: string; stepId: string; title: string; status: PlanStep['status']};

export function planOutline(plan: Plan, offset = 0, prompt = false) {
  const rows: OutlineRow[] = [];
  let total = 0;
  let steps = 0;
  let bytes = 0;
  let full = false;
  function include(row: OutlineRow) {
    const index = total++;
    if (index < offset || full) return;
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if ((rows.length || prompt) && (rows.length === 8 || bytes + size > 4096)) {
      full = true;
      return;
    }
    bytes += size;
    rows.push(row);
  }
  for (const phase of plan.phases) {
    include({phaseId: phase.id, title:phase.title});
    for (const step of phase.steps) {
      steps++;
      include({phaseId: phase.id, stepId:step.id, title:step.title, status:step.status});
    }
  }
  return {id:plan.id, version:plan.version, rows, offset, total, steps, nextOffset:offset+rows.length < total ? offset+rows.length : null};
}

export function planProjection(plan: Plan, role: AgentRole, ref?: PlanStepRef) {
  if (role === 'architect') return planOutline(plan,0,true);
  const phase = plan.id === ref?.planId && plan.version === ref?.planVersion
    ? plan.phases.find(phase => phase.id === ref?.phaseId) : undefined;
  const step = phase?.steps.find(step => step.id === ref?.stepId);
  return {
    id:plan.id, version:plan.version, steps:plan.phases.reduce((total,phase) => total + phase.steps.length,0),
    ...(step ? {step:{phaseId:phase!.id,stepId:step.id,status:step.status}} : {}),
  };
}
