import { z } from 'zod';
import {skillName,projectSkillPath,parseSkill} from './skill-files.js';
import {skillIdentity,skillSelectionInput,skillDraftInput} from './skills.js';
import type { Action, AgentRole, ChatMode, NativeToolDefinition, ToolContext, ToolInspection, ToolResult, ToolService } from '../shared/types.js';
import { parseNativeJSON } from './native-json.js';
export const packageRecommendation = z.object({
  packages: z.array(z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9+.-]{1,63}$/),
    version: z.string().regex(/^[0-9][A-Za-z0-9.+:~\-]{0,127}$/).optional(),
  }).strict()).min(1).max(16),
  reason: z.string().trim().min(1).max(2000),
}).strict().refine(value => new Set(value.packages.map(p => p.name)).size === value.packages.length);



// These are transport bounds, not filesystem authorization. WorkspaceTools must
// still validate paths, versions, permissions, leases, and action effects.
export const PROTOCOL_LIMITS = Object.freeze({
  contentCharacters: 1_000_000,
  pathCharacters: 4_096,
  commandCharacters: 64_000,
  timeoutMs: 600_000,
});

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(value=>Buffer.byteLength(value)<=max,'UTF-8 byte limit exceeded')
    .refine(value => value.trim().length > 0, 'Must not be blank');

const path = text(PROTOCOL_LIMITS.pathCharacters).refine(
  value => !value.includes('\0'),
  'Path must not contain NUL',
);

const timeoutMs = z
  .number()
  .int()
  .min(1)
  .max(PROTOCOL_LIMITS.timeoutMs)
  .optional();

const id = text(200);
const baseHash = z.string().regex(/^[a-f0-9]{64}$/);
const edits = z.array(z.strictObject({startLine: z.number().int().min(1).max(1_000_001), deleteCount: z.number().int().min(0).max(1_000_000), text: z.string().max(128_000).refine(value => Buffer.byteLength(value) <= 128_000)})).min(1).max(100);

const stepSchema = z.strictObject({
  id,
  title: text(2_000),
  status: z.enum(['pending', 'in_progress', 'done', 'blocked']),
});

export const planPhaseSchema = z.strictObject({
  id,
  title: text(2_000),
  steps: z.array(stepSchema).max(100),
});

const phases = z.array(planPhaseSchema).max(50).superRefine(
  (values, context) => {
    const phaseIds = new Set<string>();
    const stepIds = new Set<string>();

    for (const phase of values) {
      if (phaseIds.has(phase.id)) {
        context.addIssue({
          code: 'custom',
          message: 'Duplicate phase ID',
        });
      }

      phaseIds.add(phase.id);

      for (const step of phase.steps) {
        if (stepIds.has(step.id)) {
          context.addIssue({
            code: 'custom',
            message: 'Duplicate step ID',
          });
        }

        stepIds.add(step.id);
      }
    }
  },
);

const planSource = z.strictObject({path: text(1024), callId: id, symbol: z.string().regex(/^[A-Za-z_$][\w$]{0,79}$/).optional(), excerpt: text(200).optional()});
const planAdmission = z.array(z.strictObject({
  phaseId: id,
  stepId: id,
  sources: z.array(planSource).max(8),
  newFiles: z.array(z.strictObject({path: text(1024), callId: id})).max(8),
  checks: z.array(z.strictObject({method: z.enum(['test','inspection']), target: text(1024), expected: text(600)})).min(1).max(4),
  task: z.strictObject({
    objective:text(600),
    dependsOn:z.array(z.strictObject({phaseId:id,stepId:id})).max(4)
      .refine(deps => new Set(deps.map(dep => JSON.stringify([dep.phaseId,dep.stepId]))).size === deps.length).optional(),
  }).optional(),
})).max(16);

export const actionSchema = z.discriminatedUnion('name', [
  z.strictObject({name: z.literal('inspect_new_plan_path'), args: z.strictObject({path: text(1024)})}),
  z.strictObject({name:z.literal('discover_skills'),args:z.strictObject({})}),
  z.strictObject({name:z.literal('load_skill'),args:skillIdentity}),
  z.strictObject({name:z.literal('draft_skill'),args:skillDraftInput}),
  z.strictObject({name:z.literal('invoke_skill'),args:skillSelectionInput}),
  z.strictObject({name:z.literal('save_skill'),args:z.strictObject({name:skillName,content:z.string().max(32000),baseHash:z.string().regex(/^[a-f0-9]{64}$/).nullable()})}),
  z.strictObject({name:z.literal('start_process'),args:z.strictObject({command:text(PROTOCOL_LIMITS.commandCharacters),timeoutMs,cwd:path.optional(),})}),
  z.strictObject({name:z.literal('process_status'),args:z.strictObject({processId:z.string().uuid(),waitMs:z.number().int().min(0).max(1000).optional()})}),
  z.strictObject({name:z.literal('process_output'),args:z.strictObject({processId:z.string().uuid(),offset:z.number().int().min(0).max(64_000),limit:z.number().int().min(4).max(16_000).optional(),waitMs:z.number().int().min(0).max(1000).optional()})}),
  z.strictObject({name:z.literal('cancel_process'),args:z.strictObject({processId:z.string().uuid()})}),
  z.strictObject({name: z.literal('read_file_range'), args: z.strictObject({path, startLine: z.number().int().positive().max(2_000_001), count: z.number().int().min(1).max(500)})}),
  z.strictObject({name: z.literal('search_page'), args: z.strictObject({path: z.union([path,z.literal('')]).optional(), query: text(1000), offset: z.number().int().min(0).max(10_000).optional(), limit: z.number().int().min(1).max(100).optional(), revision: baseHash.optional()})}),
  z.strictObject({name: z.literal('patch_file'), args: z.strictObject({path, baseHash: baseHash.nullable(), edits})}),
  z.strictObject({name: z.literal('maintain_instructions'), args: z.strictObject({path: path.refine(value => value === 'AGENTS.md' || /^(?:[^\\/]+\/)+AGENTS\.md$/.test(value)), baseHash: baseHash.nullable(), edits})}),
  z.strictObject({name: z.literal('delete_file'), args: z.strictObject({path, baseHash})}),
  z.strictObject({name: z.literal('rename_file'), args: z.strictObject({path, destination: path, baseHash})}),
  z.strictObject({ name: z.literal('request_goal_completion'), args: z.strictObject({goalId:id,goalRevision:z.number().int().positive(),planId:id,planVersion:z.number().int().positive(),modeVersion:z.number().int().nonnegative(),reviewEventIds:z.array(z.number().int().positive()).min(1).max(256)}) }),
  z.strictObject({ name: z.literal('submit_completion'), args: z.strictObject({ summary: text(64_000) }) }),
  z.strictObject({ name: z.literal('install_decision'), args: z.strictObject({ decision: z.enum(['approve','reject','ask']), reason: text(400) }) }),
  z.strictObject({ name: z.literal('recommend_packages'), args: packageRecommendation }),
  z.strictObject({
    name: z.literal('list_files'),
    args: z.strictObject({ path: z.union([path, z.literal('')]).optional() }),
  }),
  z.strictObject({
    name: z.literal('read_file'),
    args: z.strictObject({ path }),
  }),
  z.strictObject({
    name: z.literal('search'),
    args: z.strictObject({
      query: text(1_000),
      path: z.union([path, z.literal('')]).optional(),
    }),
  }),
  z.strictObject({
    name: z.literal('write_file'),
    args: z.strictObject({
      path,
      content: z.string().max(PROTOCOL_LIMITS.contentCharacters).refine(value=>Buffer.byteLength(value)<=PROTOCOL_LIMITS.contentCharacters).describe('File content, at most 1000000 UTF-8 bytes.'),
      baseHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    }),
  }),
  z.strictObject({
    name: z.literal('run_shell'),
    args: z.strictObject({
      command: text(PROTOCOL_LIMITS.commandCharacters),
      cwd:path.optional(),
      timeoutMs,
    }),
  }),
  z.strictObject({
    name: z.literal('execute_python'),
    args: z.strictObject({
      code: text(PROTOCOL_LIMITS.commandCharacters),
      cwd:path.optional(),
      timeoutMs,
    }),
  }),
  z.strictObject({
    name: z.literal('git_status'),
    args: z.strictObject({}),
  }),
  z.strictObject({
    name: z.literal('git_diff'),
    args: z.strictObject({ path: z.union([path, z.literal('')]).optional() }),
  }),
  z.strictObject({
    name: z.literal('run_tests'),
    args: z.strictObject({
      command: text(PROTOCOL_LIMITS.commandCharacters),
      reportPath: path.optional(),
      cwd:path.optional(),
      timeoutMs,
    }),
  }),
  z.strictObject({
    name: z.literal('read_plan'),
    args: z.strictObject({planId:id,planVersion:z.number().int().positive(),offset:z.number().int().min(0).max(5050)}),
  }),
  z.strictObject({
    name: z.literal('set_plan'),
    args: z.strictObject({ phases, admission: planAdmission.optional() }),
  }),
  z.strictObject({
    name: z.literal('delegate'),
    args: z.strictObject({
      evidenceKind:z.enum(['workspace','observation']).optional(),
      goal: z.strictObject({goalId:id,goalRevision:z.number().int().positive(),criterionIds:z.array(id).min(1).max(32).refine(ids=>new Set(ids).size===ids.length)}).optional(),
      planStep: z.strictObject({planId: id, planVersion: z.number().int().positive(), phaseId: id, stepId: id}).optional(),
      objective: text(16_000),
      acceptanceCriteria: z.array(text(4_096)).min(1).max(100),
      paths: z.array(path).max(100).optional(),
    }),
  }),
  z.strictObject({
    name: z.literal('review_result'),
    args: z.strictObject({
      verdict: z.enum(['pass', 'changes_requested']),
      findings: z.array(text(8_000)).max(100),
      replan: z.strictObject({
        reason: z.enum(['architecture_conflict','dependency_blocked','invalid_assumption','scope_change']),
        explanation: text(768),
        evidenceEventIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(4),
      }).optional(),
    }),
  }),
  z.strictObject({
    name: z.literal('review'),
    args: z.strictObject({ focus: text(16_000) }),
  }),
  z.strictObject({
    name: z.literal('ask_user'),
    args: z.strictObject({ question: text(16_000) }),
  }),
]);

export type ValidatedAction = z.infer<typeof actionSchema>;


export type ToolRole = AgentRole | 'install_reviewer';
export interface RegistryDispatch {
  workspace: ToolService;
  context: ToolContext;
  control: (action: Action) => Promise<ToolResult>;
  process?: (action:Action) => Promise<ToolResult>;
}
export interface ToolDefinition {
  name: string;
  description: string;
  arguments: z.ZodType;
  result: z.ZodType<ToolResult>;
  roles: readonly ToolRole[];
  modes: readonly ChatMode[];
  effect: ToolInspection['effect'];
  risk: ToolInspection['risk'];
  kind: 'workspace' | 'control' | 'decision';
  terminal: boolean;
  fileMutation: boolean;
  command: boolean;
  managedProcess: boolean;
  approval: 'normal'|'owned_stop';
  affectedPaths: (action: Action) => string[];
  inspect: (dispatch: RegistryDispatch, action: Action) => Promise<ToolInspection>;
  handler: (dispatch: RegistryDispatch, action: Action) => Promise<ToolResult>;
}
export const RESULT_LIMITS=Object.freeze({outputBytes:2_100_000,dataBytes:16_000_000,dataNodes:100_000,depth:64});
function boundedResultData(value:unknown):boolean {
  let nodes=0;
  const ancestors=new Set<object>();
  const walk=(item:unknown,depth:number):boolean=>{
    if(++nodes>RESULT_LIMITS.dataNodes || depth>RESULT_LIMITS.depth)return false;
    if(item===null || item===undefined || typeof item==='boolean' || typeof item==='string')return true;
    if(typeof item==='number')return Number.isFinite(item);
    if(typeof item!=='object' || ancestors.has(item))return false;
    if(!Array.isArray(item) && Object.getPrototypeOf(item)!==Object.prototype && Object.getPrototypeOf(item)!==null)return false;
    ancestors.add(item);
    const valid=Object.values(item).every(child=>walk(child,depth+1));
    ancestors.delete(item);
    return valid;
  };
  try{return walk(value,0) && Buffer.byteLength(JSON.stringify(value)??'null')<=RESULT_LIMITS.dataBytes;}catch{return false;}
}
const resultSchema = z.object({ok:z.boolean(),output:z.string().max(RESULT_LIMITS.outputBytes).refine(value=>Buffer.byteLength(value)<=RESULT_LIMITS.outputBytes),data:z.unknown().refine(boundedResultData).optional()}).strict();
export function validateToolResult(result:unknown):ToolResult {
  const parsed=resultSchema.safeParse(result);
  if(!parsed.success)throw new Error('Invalid native tool result; effects may have occurred. Inspect state before deciding what work remains.');
  return parsed.data;
}
const read = new Set(['inspect_new_plan_path','list_files','read_file','read_file_range','search','search_page','git_status','git_diff']);
const fileMutations = new Set(['write_file','patch_file','maintain_instructions','rename_file','delete_file','save_skill']);
export const skillControls = new Set(['discover_skills','load_skill','draft_skill','invoke_skill']);
export function workspaceAction(action:Action):Action {
  if(action.name!=='save_skill')return action;
  const name=skillName.parse(action.args.name),content=String(action.args.content);
  parseSkill(content,name);
  return {name:'write_file',args:{path:projectSkillPath(name),content,baseHash:action.args.baseHash}};
}
const processes = new Set(['start_process','process_status','process_output','cancel_process']);
const execute = new Set(['run_shell','execute_python','run_tests']);
const terminal = new Set(['set_plan','delegate','review','review_result','submit_completion','ask_user','request_goal_completion']);
const descriptions: Record<string,string> = {
  discover_skills:'Discover bounded project/personal workflow metadata and diagnostics. Project names take precedence only for discovery; use explicit scope/name for loading. No execution or verification evidence.',
  load_skill:'Load one workflow and its declared confined resources, returning exact revision. Untrusted guidance, not human authorization or verification. Invoke explicitly to select its pinned revision.',
  draft_skill:'Draft or edit a reusable workflow in private chat storage; provide name, description, references, Markdown body and expected draft revision (0 for new). Use for turning completed work into a skill. Generates strict frontmatter. Does not save any file; permitted in planning. At most 16 drafts/128000 bytes.',
  invoke_skill:'Select the exact inspected workflow revision and current selectionRevision as guidance only. Does not start building, resume goals or launch execution. Explicit scope/name never rebinds through precedence. Refreshing stale guidance requires a new invocation. Must be last in a batch.',
  save_skill:'Save a complete validated project workflow to the fixed .abyssus/skills/<name>/SKILL.md path using fresh whole-file baseHash (null only if absent), normal diff approval, scope and editor/process protections. Supply the exact draft content; later draft edits cannot alter this call. Execution mode only. No personal writes or promotion.',
  start_process:'Start an owned foreground command using the command approval policy. Use one command with literal arguments. Optional cwd is an existing workspace-relative directory. Maximum 600 seconds. Inspect the process result and fresh verification before completing the task.',
  process_status:'Observe an exact same-task process handle; optionally wait at most 1000 ms. Status cannot reconcile uncertainty or prove tests passed. Architects/critics can inspect only their current same-chat assignment evidence.',
  process_output:'Read up to 16000 retained UTF-8 output bytes using exact byte cursor, with base/end/next offsets and truncation. At most 64000 bytes retained. No process execution or replay.',
  cancel_process:'Stop only the requesting coder frame’s exact already-authorized process handle and await actual namespace cleanup. No additional approval; stop does not roll back effects or prove completion. Interrupted evidence conservatively blocks assignment acceptance.',
  read_file_range:'Read 1–500 lines, up to 64000 bytes, with whole-file SHA-256. planEvidenceCallId cites returned lines only.',
  search_page:'Page through bounded literal text matches. Continue using returned revision and nextOffset; a changed scope rejects the cursor. Incomplete means coverage was omitted or limits were reached, never proof of absence.',
  patch_file:'Apply ordered nonoverlapping original-file line intervals using a fresh whole-file baseHash. startLine is one-based, deleteCount counts complete lines, text is literal replacement including intended newline bytes. Insertion at EOF uses original line count + 1. Retains all other bytes.',
  maintain_instructions:'Architect maintenance of only canonical AGENTS.md files: ordered literal line patches for structure, commands, conventions and durable decisions. Preserve user guidance and keep live goals/progress in database. Fresh baseHash, editor leases and ordinary diff/approval checks apply. Planning may draft prose only.',
  delete_file:'Remove one regular text file only at its freshly observed baseHash. Preview includes all deleted text. Dirty buffers and changed identity reject; uncertain effects cannot be retried.',
  rename_file:'Move a regular text file to an absent destination, using fresh source baseHash and protecting both editor leases. Exclusive destination creation then source removal prevents overwriting collisions; partial effects remain uncertain. Both paths must be in assignment scope.',
  request_goal_completion:'Request whole-goal completion using the exact current goal and plan revisions and recorded accepted review event IDs. Runtime checks all protected criteria/steps, current evidence and uncertainty. Claims, removed steps and critic PASS alone do not suffice. Must be last in a batch.',
  list_files:'List a confined project directory. Omit path for the root.',
  read_file:'Read project UTF-8 and SHA-256. Cite planEvidenceCallId when returned. Use read_file_range for truncated output.',
  search:'Search bounded project text. Protected files are excluded.',
  write_file:'Replace a project file using its freshly observed SHA-256 baseHash, or null for a new file. Requires scope, lease, version and approval checks.',
  run_shell:'Run one command with literal arguments from the workspace root or optional relative cwd. Keep paths inside the workspace; shell chaining, redirects and substitutions are unavailable. Commands can modify files and may require approval. Never replay uncertain work.',
  execute_python:'Run Python from the workspace root or optional relative cwd with the command approval policy. Keep filesystem actions scoped to the workspace.',
  run_tests:'Run a potentially modifying test command and collect a fresh JUnit report. A command exit alone does not prove the report passed.',
  git_status:'Read confined Git status without hooks or credential access.',
  git_diff:'Read confined Git changes with protected paths excluded.',
  inspect_new_plan_path:'Observe absence of a proposed new project file. Cite the returned planEvidenceCallId in set_plan.',
  read_plan:'Page the exact revision in order, including empty phases. Start at offset 0 and follow nextOffset until null.',
  set_plan:'Replace the full ordered outline. Cite native reads/absence and observable checks on changed steps. Optional admission.task saves task metadata. Cite a retained step for reorder or removal. Use phases: [] to clear. Last in batch.',
  delegate:'Assign one coder a bounded objective, verifiable acceptance criteria and scoped paths. For related planned work bind planStep to exact current identities and revision; omit it for unrelated work. Must be last in a batch.',
  review:'Request an independent read-only review of a concrete focus. This does not accept unrelated plan steps or a whole phase. Must be last in a batch.',
  review_result:'Record a critic judgment from actual files, diffs and verification. Use changes_requested for local repairs. In a completion review, optionally cite exact observed receipt IDs and a reason for genuine replanning. PASS cannot override runtime evidence or grant authority. Must be last in a batch.',
  ask_user:'Pause for necessary user information. Must be the last call in a batch.',
  submit_completion:'Submit the current work frame for completion with observed evidence and limitations. Coder completion requires independent review. Does not prove goal completion. Must be the last call in a batch.',
  recommend_packages:'Propose up to 16 unique apt package identities with a specific need. Separate system policy, target freshness and helper authorization apply; never grants shell or root access.',
  install_decision:'Return only an independent install assessment from curated evidence. This decision grants no execution capability.',
};
export const toolRegistry: ReadonlyMap<string,ToolDefinition> = new Map(actionSchema.options.map(option => {
  const name = option.shape.name.value;
  const workspace = read.has(name) || execute.has(name) || fileMutations.has(name) || processes.has(name);
  const effect = execute.has(name) || name === 'recommend_packages' || name === 'start_process' || name === 'cancel_process' ? 'execute' : fileMutations.has(name) ? 'write' : 'read';
  const roles: ToolRole[] = name==='discover_skills'||name==='load_skill' ? ['architect','coder','critic'] : skillControls.has(name)||name==='save_skill' ? ['architect','coder'] : ['maintain_instructions','inspect_new_plan_path'].includes(name) ? ['architect'] : name === 'install_decision' ? ['install_reviewer'] : read.has(name) || name === 'process_status' || name === 'process_output' ? ['architect','coder','critic'] : name === 'review_result' ? ['critic'] : name === 'submit_completion' || name === 'recommend_packages' ? ['architect','coder'] : workspace ? ['coder'] : ['architect'];
  const definition: ToolDefinition = {
    name, description:descriptions[name], arguments:option.shape.args, result:resultSchema, roles,
    fileMutation: fileMutations.has(name), command: execute.has(name),
    managedProcess: processes.has(name), approval: name==='cancel_process'?'owned_stop':'normal',
    affectedPaths: action => action.name==='save_skill' ? [projectSkillPath(String(action.args.name))] : [action.args.path,action.args.destination].filter((value):value is string=>typeof value==='string'),
    modes: effect !== 'read' || name === 'delegate' || name === 'request_goal_completion' ? ['execute'] : ['plan','execute'],
    effect, risk:effect === 'execute' ? 'elevated' : 'routine', kind:workspace ? 'workspace' : name === 'install_decision' ? 'decision' : 'control', terminal:terminal.has(name)||name==='invoke_skill',
    inspect:async (dispatch,action) => name==='start_process'
      ? dispatch.workspace.inspect(dispatch.context,{name:'run_shell',args:{command:action.args.command,cwd:action.args.cwd,timeoutMs:action.args.timeoutMs}})
      : workspace && !processes.has(name) ? dispatch.workspace.inspect(dispatch.context,action) : {effect,risk:effect === 'execute' ? 'elevated' : 'routine',description:descriptions[name]},
    handler:async (dispatch,action) => {
      if(processes.has(name)&&!dispatch.process)throw new Error('Trusted process lifecycle is unavailable');
      const result=await (processes.has(name) ? dispatch.process!(action) : workspace ? dispatch.workspace.execute(dispatch.context,action) : dispatch.control(action));
      return validateToolResult(result);
    },
  };
  return [name,definition];
}));
export function definitionFor(name:string): ToolDefinition {
  const definition = toolRegistry.get(name);
  if (!definition) throw new Error('Unknown native tool');
  return definition;
}
export function validateAction(action: Action, role?: ToolRole, mode?: ChatMode): Action {
  const definition = definitionFor(action.name);
  if (role && !definition.roles.includes(role) || mode && !definition.modes.includes(mode)) throw new Error('Native tool is not permitted for this role or mode');
  const parsed = definition.arguments.safeParse(action.args);
  if (!parsed.success) throw new Error('Invalid native tool arguments');
  const args = parsed.data as Record<string,unknown>;
  if (action.name === 'review_result' && args.replan) {
    const {evidenceEventIds} = args.replan as import('../shared/types.js').ReviewReplan;
    if (args.verdict !== 'changes_requested' || new Set(evidenceEventIds).size !== evidenceEventIds.length) {
      throw new Error('Replanning requires changes_requested and distinct receipt IDs.');
    }
  }
  return {name:action.name,args};
}
export function parseToolArguments(name:string,args:string): Action {
  return validateAction({name,args:parseNativeJSON(args) as Record<string,unknown>});
}
export function publishedTools(role:ToolRole,mode:ChatMode='execute'): NativeToolDefinition[] {
  return [...toolRegistry.values()].filter(d=>d.roles.includes(role)&&d.modes.includes(mode)).map(d=>{
    // The model sees the embedded schema, not a standalone dialect document.
    const {$schema: _dialect, ...parameters} = z.toJSONSchema(d.arguments);
    return {type:'function',function:{name:d.name,description:d.description,parameters}};
  });
}
