import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Goal, GoalRef, GoalRevision, GoalStatus, GoalStep, Plan, InstallSettings, ContainerInstallReceipt } from '../shared/types.js';
import type { Store } from './store.js';
import type { Frame } from './runtime.js';
import type { ScopeSnapshot } from './verification-scope.js';
import { assignmentBlockers, type AssignmentEvidence } from './assignment-evidence.js';
import { helperCanonical } from './package-helper.js';

const boundedText = (max: number) => z.string().trim().min(1).max(max).refine(text=>Buffer.byteLength(text)<=max);
const goalShape={objective: boundedText(16000), acceptanceCriteria: z.array(boundedText(4096)).min(1).max(32).refine(items=>new Set(items).size===items.length,'Duplicate criteria are ambiguous'),observationCriteria:z.array(z.number().int().nonnegative()).max(32).optional()};
const validIndexes=(input:{acceptanceCriteria:string[];observationCriteria?:number[]})=>new Set(input.observationCriteria).size===(input.observationCriteria?.length??0) && (input.observationCriteria??[]).every(index=>index<input.acceptanceCriteria.length);
export const goalInput = z.strictObject(goalShape).refine(validIndexes,'Observation criterion indexes must be unique and in range');
export const goalRevisionInput = z.strictObject({...goalShape,expectedRevision:z.number().int().positive(), reason:boundedText(2000)}).refine(validIndexes,'Observation criterion indexes must be unique and in range');
export type GoalInput = z.infer<typeof goalInput>;
export interface GoalAcceptance { reviewEventId: number; goalId: string; revision: number; generation: number; frame: Pick<Frame,'id'|'assignment'|'planStep'|'evidenceEventIds'>; scope: ScopeSnapshot }
interface Obligation { key: string; revision: number; evidence: AssignmentEvidence }
interface InstallUncertaintyLink {eventId:number;installId:string;targetKey:string;previewDigest:string}
export interface InstallRecoveryReceipt {containerReceipt?:ContainerInstallReceipt;installId:string;chatId:string;targetKey:string;previewDigest:string;method:'status'|'reconcile';eventId:number;state:string;healthy:boolean;matches:boolean}
export const goalOf = (store: Store, chatId: string) => store.getState<Goal | undefined>(`goal:${chatId}`,undefined);
export const acceptances = (store: Store, chatId: string) => store.getState<GoalAcceptance[]>(`goal-evidence:${chatId}`,[]);
export function saveGoal(store: Store, chatId: string, goal: Goal) {
  goal.updatedAt=new Date().toISOString();
  store.setState(`goal:${chatId}`,goal);store.event(chatId,'goal',goal);
}
export function goalStatus(store: Store, chatId: string, status: GoalStatus, reason: string) {
  const goal=goalOf(store,chatId);if(!goal || goal.status==='completed')return;
  if(goal.status===status && goal.reason===reason)return;
  saveGoal(store,chatId,{...goal,status,reason});
}

/** Only a real tool outcome or a store recovery event can link uncertainty to
 * an install. A caller/model-supplied event ID or status is never a receipt. */
export function addGoalUncertainty(store:Store,chatId:string,goal:Goal,ids:number[]) {
  const union=[...new Set([...goal.uncertainEventIds,...ids])];goal.uncertaintyOverflow ||= union.length>100;goal.uncertainEventIds=union.slice(0,100);
  const links=store.getState<InstallUncertaintyLink[]>(`goal-install-links:${chatId}`,[]);
  for(const eventId of goal.uncertainEventIds) {
    if(links.some(link=>link.eventId===eventId))continue;
    const row=store.db.prepare('SELECT type,data FROM events WHERE id=? AND chat_id=?').get(eventId,chatId);if(!row)continue;
    const data=JSON.parse(String(row.data)) as {installId?:string;agentId?:string;action?:{name?:string};result?:{data?:{installId?:string}}};
    const installId=row.type==='goal_uncertainty'?data.installId:row.type==='tool' && data.action?.name==='recommend_packages'?data.result?.data?.installId:undefined;
    if(!installId)continue;
    const install=store.installs().find(item=>item.id===installId && item.chatId===chatId);
    if(!install?.settings.target || !install.previewDigest || row.type==='tool' && data.agentId!==install.frameId)continue;
    if(links.length<100)links.push({eventId,installId,targetKey:helperCanonical(install.settings.target),previewDigest:install.previewDigest});else goal.uncertaintyOverflow=true;
  }
  store.setState(`goal-install-links:${chatId}`,links);
}
export function installResolutions(store:Store,chatId:string,goal:Goal):NonNullable<Goal['resolvedUncertainties']> {
  const selected=store.getState<InstallSettings|null>('system-installs:v1',null)?.target;
  return store.getState<InstallUncertaintyLink[]>(`goal-install-links:${chatId}`,[]).flatMap(link=>{
    if(!goal.uncertainEventIds.includes(link.eventId))return [];
    const receipt=store.getState<InstallRecoveryReceipt|null>(`install-reconciliation:${link.installId}`,null);
    const install=store.installs().find(item=>item.id===link.installId && item.chatId===chatId);
    const container=install?.settings.target?.scope==='project-container';
    if(container?(!install?.containerReceipt||helperCanonical(receipt?.containerReceipt??null)!==helperCanonical(install.containerReceipt)):(!selected||helperCanonical(selected)!==link.targetKey))return [];
    if(!receipt || receipt.installId!==link.installId || receipt.chatId!==chatId || receipt.targetKey!==link.targetKey || receipt.previewDigest!==link.previewDigest || receipt.state!=='succeeded' || !receipt.healthy || !receipt.matches || !['status','reconcile'].includes(receipt.method) || !install || install.state!=='succeeded' || install.recoveryRequired || !install.reconciliation?.healthy || !install.reconciliation.matches || install.previewDigest!==link.previewDigest || helperCanonical(install.settings.target)!==link.targetKey)return [];
    const event=store.db.prepare("SELECT data FROM events WHERE id=? AND chat_id=? AND type='install_reconciliation'").get(receipt.eventId,chatId);
    if(!event || (JSON.parse(String(event.data)) as {installId?:string}).installId!==link.installId)return [];
    return [{eventId:link.eventId,installId:link.installId,reconciliationEventId:receipt.eventId}];
  });
}
export function unresolvedGoalEvents(store:Store,chatId:string,goal:Goal) {
  const resolved=new Set(appliedInstallResolutions(store,chatId,goal).map(item=>item.eventId));
  return goal.uncertainEventIds.filter(id=>!resolved.has(id));
}
export function activeGoalEvidence(store:Store,chatId:string,evidence:AssignmentEvidence,goal=goalOf(store,chatId)):AssignmentEvidence {
  if(!goal)return evidence;
  const resolved=new Set(appliedInstallResolutions(store,chatId,goal).map(item=>item.eventId));
  return {...evidence,uncertainEventIds:evidence.uncertainEventIds.filter(id=>!resolved.has(id))};
}
function appliedInstallResolutions(store:Store,chatId:string,goal:Goal) {
  return installResolutions(store,chatId,goal).filter(valid=>goal.resolvedUncertainties?.some(applied=>applied.eventId===valid.eventId && applied.installId===valid.installId && applied.reconciliationEventId===valid.reconciliationEventId));
}
export function refreshGoalResolutions(store:Store,chatId:string) {
  const goal=goalOf(store,chatId);if(!goal || goal.status==='completed')return;
  goal.resolvedUncertainties=installResolutions(store,chatId,goal);
  goal.verificationBlockers=store.getState<Obligation[]>(`goal-obligations:${chatId}`,[]).filter(item=>item.revision===goal.revision).flatMap(item=>assignmentBlockers({acceptanceEvidence:activeGoalEvidence(store,chatId,item.evidence)} as Frame));
  if(goal.status==='blocked' && goal.resolvedUncertainties.length>0 && !unresolvedGoalEvents(store,chatId,goal).length && !goal.uncertaintyOverflow && !goal.evidenceOverflow) {goal.status='paused';goal.reason='Exact install uncertainty was resolved by explicit authenticated helper recovery. Review evidence and Resume to continue; no install is replayed.';}
  saveGoal(store,chatId,goal);
}
export const planScope = (plan: Plan): GoalStep[] => plan.phases.flatMap(phase=>phase.steps.map(step=>({phaseId:phase.id,phaseTitle:phase.title,stepId:step.id,title:step.title})));
const sameStep = (a: GoalStep,b: GoalStep) => JSON.stringify(a)===JSON.stringify(b);
export function protectPlan(store: Store, chatId: string, plan: Plan) {
  const goal=goalOf(store,chatId);if(!goal || goal.status==='completed')return;
  for(const step of planScope(plan))if(!goal.requiredSteps.some(old=>sameStep(old,step)))goal.requiredSteps.push(step);
  if(goal.requiredSteps.length>256)throw new Error('Goal required scope exceeds 256 steps; explicitly revise the goal before continuing.');
  goal.reviews=[];goal.generation++;
  saveGoal(store,chatId,goal);
}
export function createGoal(store: Store, chatId: string, input: GoalInput, humanMessageId: string, revision?: {expectedRevision:number;reason:string}) {
  input=goalInput.parse(input);
  const old=goalOf(store,chatId);
  if(old && (!revision || revision.expectedRevision!==old.revision))throw Object.assign(new Error('A goal already exists; explicitly revise its current revision and explain the superseded scope.'),{statusCode:409});
  if(!old && revision)throw Object.assign(new Error('No goal exists to revise.'),{statusCode:409});
  if(old && old.superseded.length>=31)throw new Error('Goal revision limit reached; retain this history and use a new chat for new work.');
  const previous:GoalRevision[] = old ? [...old.superseded,{revision:old.revision,objective:old.objective,criteria:old.criteria,requiredSteps:old.requiredSteps,humanMessageId:old.humanMessageId,reason:revision!.reason,verificationBlockers:old.verificationBlockers}] : [];
  const goal:Goal={id:old?.id??randomUUID(),revision:(old?.revision??0)+1,objective:input.objective,
    criteria:input.acceptanceCriteria.map((text,index)=>{const evidenceKind=input.observationCriteria?.includes(index)?'observation':'workspace';return {id:old?.criteria.find(item=>item.text===text && item.evidenceKind===evidenceKind)?.id??randomUUID(),text,evidenceKind};}),requiredSteps:planScope(store.plan(chatId)),humanMessageId,
    superseded:previous,status:store.chat(chatId).mode==='plan'?'waiting_for_user':'running',reason:store.chat(chatId).mode==='plan'?'Planning only. Start building explicitly to authorize execution.':'Explicit human goal recorded.',
    generation:(old?.generation??0)+1,createdAt:old?.createdAt??new Date().toISOString(),updatedAt:new Date().toISOString(),reviews:[],uncertainEventIds:old?.uncertainEventIds??[],uncertaintyOverflow:old?.uncertaintyOverflow,evidenceOverflow:old?.evidenceOverflow,verificationBlockers:[],
    budget:{turns:0,transitions:0,unchangedTurns:0,maxTurns:128,maxTransitions:256,maxUnchangedTurns:16}};
  if(goal.requiredSteps.length>256)throw new Error('Goal required scope exceeds 256 steps.');
  const obligations=store.getState<Obligation[]>(`goal-obligations:${chatId}`,[]);
  for(const obligation of obligations) {
    const binding=JSON.parse(obligation.key) as {goal?:GoalRef;paths?:string[];plan?:{phaseId:string;stepId:string}};
    const surviving=binding.goal?.criterionIds.filter(id=>goal.criteria.some(criterion=>criterion.id===id))??[];
    if(old && binding.goal?.goalRevision===old.revision && surviving.length) {
      // Keeping any affected criterion retains the failed-check obligation,
      // including after a human renames/remaps a plan step. A new unrelated
      // assignment cannot erase the original check by changing its association.
      binding.goal.goalRevision=goal.revision;binding.goal.criterionIds=surviving;
      obligation.key=JSON.stringify(binding);obligation.revision=goal.revision;
    }
  }
  store.setState(`goal-obligations:${chatId}`,obligations);
  goal.verificationBlockers=obligations.filter(item=>item.revision===goal.revision).flatMap(item=>assignmentBlockers({acceptanceEvidence:item.evidence} as Frame));
  const uncertain=store.db.prepare("SELECT id FROM events WHERE chat_id=? AND ((type='tool' AND (json_extract(data,'$.result.data.uncertain')=1 OR json_extract(data,'$.result.data.recoveryRequired')=1 OR json_extract(data,'$.result.data.state')='uncertain')) OR (type='command' AND json_extract(data,'$.status') IN ('uncertain','interrupted')) OR type='goal_uncertainty') LIMIT 101").all(chatId).map(row=>Number(row.id));
  addGoalUncertainty(store,chatId,goal,uncertain);
  goal.resolvedUncertainties=old ? appliedInstallResolutions(store,chatId,{...goal,resolvedUncertainties:old.resolvedUncertainties}) : installResolutions(store,chatId,goal);
  goal.verificationBlockers=obligations.filter(item=>item.revision===goal.revision).flatMap(item=>assignmentBlockers({acceptanceEvidence:activeGoalEvidence(store,chatId,item.evidence,goal)} as Frame));
  if(unresolvedGoalEvents(store,chatId,goal).length || goal.uncertaintyOverflow){goal.status='blocked';goal.reason='Recorded uncertain effects remain unresolved; revising the goal cannot authorize replay or completion.';}
  if(goal.evidenceOverflow){goal.status='blocked';goal.reason='Goal verification evidence exceeded its bounded ledger; acceptance remains unverified. Retain this history for inspection.';}
  saveGoal(store,chatId,goal);return goal;
}
export function parseGoalCommand(content: string): GoalInput | undefined {
  if(!/^\/goal(?:\s|$)/.test(content.trim()))return;
  const lines=content.trim().replace(/^\/goal\s*/,'').split(/\r?\n/);
  const acceptanceCriteria=lines.filter(line=>/^\s*-\s+/.test(line)).map(line=>line.replace(/^\s*-\s+/,''));
  const objective=lines.filter(line=>!/^\s*-\s+/.test(line)).join('\n').trim();
  return goalInput.parse({objective,acceptanceCriteria:acceptanceCriteria.length?acceptanceCriteria.map(text=>text.replace(/^\[observation\](?:\s+|$)/,'')):[objective],observationCriteria:acceptanceCriteria.flatMap((text,index)=>/^\[observation\](?:\s+|$)/.test(text)?[index]:[])});
}
export function invalidateGoal(store: Store, chatId: string, reason: string) {
  const goal=goalOf(store,chatId);if(!goal || goal.status==='completed')return;
  goal.generation++;goal.reviews=[];goal.reason=reason;saveGoal(store,chatId,goal);
}
export function bindGoal(store: Store, chatId: string, reference: GoalRef | undefined) {
  const goal=goalOf(store,chatId);if(!goal || goal.status==='completed')return undefined;
  if(!reference || reference.goalId!==goal.id || reference.goalRevision!==goal.revision || !reference.criterionIds.length || reference.criterionIds.some(id=>!goal.criteria.some(item=>item.id===id)))throw new Error('Delegation needs the current goal ID/revision and actual criterion IDs.');
  return goal;
}
export function goalBlockers(store: Store, chatId: string, goal: Goal, plan: Plan): string[] {
  const blockers:string[]=[...goal.verificationBlockers];
  if(unresolvedGoalEvents(store,chatId,goal).length || goal.uncertaintyOverflow)blockers.push('Recorded uncertain effects cannot be cleared by a goal restart, a review or a completion request.');
  if(goal.uncertaintyOverflow)blockers.push('Uncertainty references exceed the bounded goal view; original events are retained and acceptance is blocked.');
  if(goal.evidenceOverflow)blockers.push('Goal verification evidence exceeded its bounded ledger; completion is unverified.');
  const current=planScope(plan);
  if(!current.length)blockers.push('A nonempty plan with recorded reviewed evidence is required.');
  for(const step of goal.requiredSteps)if(!current.some(item=>sameStep(item,step)))blockers.push(`Required scope missing or renamed: ${step.phaseTitle} / ${step.title}. Only an explicit human goal revision can supersede it.`);
  const valid=goal.reviews.filter(review=>review.planStep.planId===plan.id && review.planStep.planVersion===plan.version && store.planStep(chatId,review.planStep)?.evidence?.sourceEventId===review.eventId && store.planStep(chatId,review.planStep)?.status==='done');
  for(const step of current)if(!valid.some(review=>review.planStep.phaseId===step.phaseId && review.planStep.stepId===step.stepId))blockers.push(`Required reviewed step remains: ${step.title}.`);
  for(const criterion of goal.criteria)if(!valid.some(review=>review.criterionIds.includes(criterion.id)))blockers.push(`No current accepted assignment covers criterion ${criterion.id}: ${criterion.text}`);
  return blockers;
}

function obligationKey(frame: Pick<Frame,'assignment'>) {
  const goal=frame.assignment?.goal;
  return JSON.stringify({goal:goal && {...goal,criterionIds:[...goal.criterionIds].sort()},paths:frame.assignment?.paths && [...frame.assignment.paths].sort(),plan:frame.assignment?.planStep && {...frame.assignment.planStep,planVersion:undefined}});
}
export function inheritedGoalEvidence(store: Store, chatId: string, frame: Pick<Frame,'assignment'>) {
  const records=store.getState<Obligation[]>(`goal-obligations:${chatId}`,[]).filter(item=>item.key===obligationKey(frame));
  if(!records.length)return undefined;
  const combined:AssignmentEvidence={checks:[],uncertainEventIds:[],overflow:false};
  for(const {evidence} of records) {
    combined.overflow ||= evidence.overflow;
    combined.uncertainEventIds=[...new Set([...combined.uncertainEventIds,...evidence.uncertainEventIds])];
    for(const check of evidence.checks) {
      const prior=combined.checks.find(item=>item.key===check.key);
      if(!prior){combined.checks.push(structuredClone(check));continue;}
      for(const coverage of check.coverage) {
        const existing=prior.coverage.find(item=>item.id===coverage.id);
        if(existing){existing.seen=Math.max(existing.seen,coverage.seen);existing.required=Math.max(existing.required,coverage.required);}
        else prior.coverage.push({...coverage});
      }
      // A human revision can collapse mixed bindings. Reverify the union rather
      // than treating a pass from one old subset as proof for the other subset.
      prior.status='stale';
    }
  }
  return activeGoalEvidence(store,chatId,combined);
}
/** Private failed-check obligations outlive popped frames. Only matching native
 * checks in the same criterion/step/scope binding can resolve them. */
export function recordGoalEvidence(store: Store, chatId: string, frame: Frame) {
  const goal=goalOf(store,chatId);if(!goal || goal.status==='completed' || !frame.acceptanceEvidence)return;
  const records=store.getState<Obligation[]>(`goal-obligations:${chatId}`,[]);
  const key=obligationKey(frame),index=records.findIndex(item=>item.key===key);
  const item={key,revision:frame.assignment?.goal?.goalRevision??goal.revision,evidence:structuredClone(frame.acceptanceEvidence)};
  if(index!==-1) {records[index]=item;for(let other=records.length-1;other>index;other--)if(records[other].key===key)records.splice(other,1);}
  else if(records.length<256)records.push(item);
  else goal.evidenceOverflow=true;
  let coverageRemaining=10000,checksRemaining=256;
  for(const record of records) {
    if(record.evidence.checks.length>checksRemaining){record.evidence.overflow=true;record.evidence.checks=record.evidence.checks.slice(0,checksRemaining);}
    checksRemaining-=record.evidence.checks.length;
    for(const check of record.evidence.checks) {
      if(check.coverage.length>coverageRemaining){record.evidence.overflow=true;check.coverage=check.coverage.slice(0,coverageRemaining);}
      coverageRemaining-=check.coverage.length;
    }
    if(record.evidence.overflow)goal.evidenceOverflow=true;
  }
  store.setState(`goal-obligations:${chatId}`,records);
  addGoalUncertainty(store,chatId,goal,item.evidence.uncertainEventIds);
  goal.verificationBlockers=records.filter(item=>item.revision===goal.revision).flatMap(item=>assignmentBlockers({acceptanceEvidence:activeGoalEvidence(store,chatId,item.evidence)} as Frame));
  saveGoal(store,chatId,goal);
}

/** Active protected requirements are never summarized; superseded archives and
 * private coverage ledgers do not belong in model context. */
export function goalContext(goal:Goal|undefined) {
  if(!goal)return null;
  const {superseded:_history,createdAt:_created,updatedAt:_updated,...active}=goal;
  return {...active,supersededRevisions:goal.superseded.length};
}
