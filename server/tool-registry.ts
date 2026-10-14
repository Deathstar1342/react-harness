import { z } from 'zod';
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
    .describe(`Nonblank string, at most ${max} UTF-8 bytes.`)
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

export const actionSchema = z.discriminatedUnion('name', [
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
      timeoutMs,
    }),
  }),
  z.strictObject({
    name: z.literal('execute_python'),
    args: z.strictObject({
      code: text(PROTOCOL_LIMITS.commandCharacters),
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
      timeoutMs,
    }),
  }),
  z.strictObject({
    name: z.literal('set_plan'),
    args: z.strictObject({ phases }),
  }),
  z.strictObject({
    name: z.literal('delegate'),
    args: z.strictObject({
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
const read = new Set(['list_files','read_file','search','git_status','git_diff']);
const execute = new Set(['run_shell','execute_python','run_tests']);
const terminal = new Set(['delegate','review','review_result','submit_completion','ask_user']);
const descriptions: Record<string,string> = {
  list_files:'List a confined project directory. Omit path for the root.',
  read_file:'Read a project file and its current SHA-256 hash. Missing files return a null hash.',
  search:'Search bounded project text. Protected files are excluded.',
  write_file:'Replace a project file using its freshly observed SHA-256 baseHash, or null for a new file. Requires scope, lease, version and approval checks.',
  run_shell:'Run a potentially modifying command in the Linux project sandbox. Requires execution permission and may require approval; an uncertain outcome must not be replayed.',
  execute_python:'Run Python in the same Linux sandbox and approval policy as shell commands.',
  run_tests:'Run a potentially modifying test command and collect a fresh JUnit report. A command exit alone does not prove the report passed.',
  git_status:'Read confined Git status without hooks or credential access.',
  git_diff:'Read confined Git changes with protected paths excluded.',
  set_plan:'Save plan structure with unique phase and step IDs. Runtime evidence controls completion status.',
  delegate:'Assign one coder a bounded objective, acceptance criteria and optional path scope. Bind planStep to the current plan identity and revision. Must be the last call in a batch.',
  review:'Request an independent read-only critic review. Must be the last call in a batch.',
  review_result:'Record an independent critic verdict with findings grounded in observed evidence. Must be the last call in a batch.',
  ask_user:'Pause for necessary user information. Must be the last call in a batch.',
  submit_completion:'Submit the current work frame for completion with observed evidence and limitations. Coder completion requires independent review. Does not prove goal completion. Must be the last call in a batch.',
  recommend_packages:'Propose up to 16 unique apt package identities with a specific need. Separate system policy, target freshness and helper authorization apply; never grants shell or root access.',
  install_decision:'Return only an independent install assessment from curated evidence. This decision grants no execution capability.',
};
export const toolRegistry: ReadonlyMap<string,ToolDefinition> = new Map(actionSchema.options.map(option => {
  const name = option.shape.name.value;
  const workspace = read.has(name) || execute.has(name) || name === 'write_file';
  const effect = execute.has(name) || name === 'recommend_packages' ? 'execute' : name === 'write_file' ? 'write' : 'read';
  const roles: ToolRole[] = name === 'install_decision' ? ['install_reviewer'] : read.has(name) ? ['architect','coder','critic'] : name === 'review_result' ? ['critic'] : name === 'submit_completion' || name === 'recommend_packages' ? ['architect','coder'] : workspace ? ['coder'] : ['architect'];
  const definition: ToolDefinition = {
    name, description:descriptions[name], arguments:option.shape.args, result:resultSchema, roles,
    modes: effect !== 'read' || name === 'delegate' ? ['execute'] : ['plan','execute'],
    effect, risk:effect === 'execute' ? 'elevated' : 'routine', kind:workspace ? 'workspace' : name === 'install_decision' ? 'decision' : 'control', terminal:terminal.has(name),
    inspect:async (dispatch,action) => workspace ? dispatch.workspace.inspect(dispatch.context,action) : {effect,risk:effect === 'execute' ? 'elevated' : 'routine',description:descriptions[name]},
    handler:async (dispatch,action) => {
      const result=await (workspace ? dispatch.workspace.execute(dispatch.context,action) : dispatch.control(action));
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
  return {name:action.name,args:parsed.data as Record<string,unknown>};
}
export function parseToolArguments(name:string,args:string): Action {
  return validateAction({name,args:parseNativeJSON(args) as Record<string,unknown>});
}
export function publishedTools(role:ToolRole,mode:ChatMode='execute'): NativeToolDefinition[] {
  return [...toolRegistry.values()].filter(d=>d.roles.includes(role)&&d.modes.includes(mode)).map(d=>({type:'function',function:{name:d.name,description:d.description,parameters:z.toJSONSchema(d.arguments) as Record<string,unknown>}}));
}
