# abysSUS native-tool redesign

The `non-tools` branch uses [text JSON model transport](../README.md#text-only-model-branch) while retaining the internal action, approval, and persistence rules below. This report records the original native transport milestone.


## Product and model decisions


The coder starts with a Gemini3.5 Flash native-tool candidate, initially `gemini-3.5-flash-withtools` where available. Architect and critic target verified standard-lane Gemini3.5 Pro IDs; `gemini-3.5-pro` is a catalog candidate, not live-verified here. Gemini3.8 Flash remains selectable if the endpoint exposes it; do not invent an alias. The supplied beta documentation inconsistently describes plain IDs versus required capability suffixes. Use catalog metadata plus harmless capability probes, preserve unknown versus verified support, and make exact IDs configurable. Do not infer context limits from older model names. Assist-lane models that ignore tools cannot serve execution roles.

Continue through configurable `/models` and `/chat/completions`; no `/responses` dependency. All provider requests and credentials stay backend-only. New chats snapshot chosen models for consistent behavior; no migration of old prototype chats/profiles is required. Require an explicit fresh redesigned profile or reject incompatible state with clear guidance. Never delete user project folders or mutate an installed preview as part of this redesign.

## Core separation

1. Provider adapter owns HTTP/SSE, native message encoding, complete call assembly, finish/refusal/truncation semantics, usage and sanitized diagnostics. Provisional text can stream to UI; partial tool arguments never execute.
2. Tool registry owns each definition once: name, purpose, argument/result schema, allowed roles/modes, effects/risks, inspection and handler. Generate advertised schemas and validate runtime inputs from the same definition. Avoid duplicate protocol/tool schema copies. Adding tools is registration plus implementation and meaningful policy tests.
3. Agent orchestration owns architect/coder/critic frames, delegation, reviews, plan/goal revisions, steering and scheduling. It submits requested operations to existing runtime policies. Model prose cannot authorize execution, mark tests passed or end an unfinished goal.
4. Durable storage owns native conversation history, call/result identities, pending decisions, execution claims, evidence and goals. Store before dispatch; preserve uncertain outcomes and never replay them blindly.

Remove the custom response envelope, advisor normalization, fenced/prose JSON recovery and format-repair prompts/retries. There is no native-chat fallback to legacy parsing. JSON remains the native arguments representation and ordinary application serialization; both require bounded validation. Pure auxiliary calls such as compaction may return text with no tools. Structured critic/install decisions use narrowly exposed native tools and retain independent authority checks.

Native history preserves the assistant message with its complete tool-call list followed by correlated tool results. Bound call count/name/argument/result sizes and reject conflicts. Execute calls sequentially; role exposure is not authorization. A blocked/denied/failed/cancelled request returns explicit evidence when it can safely continue. Pending approvals keep the model turn suspended. Steering or cancellation invalidates unexecuted proposals. Compaction treats call/result groups atomically, retains authoritative controls outside summaries and cannot manufacture approval or completion.

## Prompts and orchestration

Versioned role prompt modules replace large repeated format instructions in `runtime.ts`. Tool descriptions explain purpose, inputs and observed results; prompts describe responsibilities and stopping conditions. Fixed controls, explicit human requests, project guidance, skills, tool output and model-written summaries have distinct trust/priority.

- Architect owns requirements, plan maintenance, bounded delegation, review cadence, routine decisions, blocker handling and user communication. Each assignment has a verifiable objective, scope, acceptance criteria and stable plan-step reference where applicable. A user update is distinct from task, phase or goal completion.
- Coder implements the bounded assignment, preserves unrelated edits, uses fresh file versions, runs appropriate checks and submits evidence-bearing completion requests.
- Critic inspects actual diffs/files/test artifacts against requirements, records actionable findings and submits a dedicated verdict. Routine internal commentary is hidden; actionable failures remain visible. Critic acceptance is evidence, not OS/package authority.
- Install reviewer receives only curated concrete package/target evidence and a dedicated decision tool. Existing system-policy revisions, freshness, failure fallback and helper restrictions remain enforced.

Evaluate eight-phase tasks, early stops, repeated discovery, missing files, failed tests, stale/manual edits, malicious repository instructions, scope drift and uncertain outcomes. Synthetic evaluations establish runtime/prompt construction behavior, not real-provider quality. Begin with one coder and serialized mutations; parallel coders are outside this sequence.

M23 implementation uses versioned server-only policy/common/role modules and a private original-assignment snapshot. Human context comes from stored current-task human messages and steering, separate from model/repository evidence. The private prompt archive records the actual request's version/digest without exposing local extension paths. Per-assignment recorded verification blockers survive a critic PASS; exact matching later complete checks may resolve known check failures but cannot erase uncertainty or unrelated required coverage. The deterministic evaluations in `tests/orchestration.test.ts` exercise the real runtime/SQLite/file paths with a synthetic provider and synthetic command results. They show six later phases still pending after a premature phase-two conclusion; they do not implement M24 continuation or establish that STARK follows the prompts. See the M23 report for evidence and limits.

## Goals

`/goal <objective>` records explicit user intent and acceptance criteria. The runtime tracks running, waiting for approval, waiting for user, paused, blocked and completed. A native response ending does not imply goal completion. When authorized work remains, the scheduler supplies current remaining scope/evidence and continues; budgets/failures have bounded, visible stopping states rather than endless retries.

Completion requests refer to a current goal/plan revision and reviewed evidence. Required steps cannot be dropped silently to manufacture completion. Keep real progress, superseded work and untested requirements visible. `/btw` steers active work; pause/resume and execution transitions remain application controls. `/goal` in plan mode does not authorize writes. A compact stable goal/phase indicator opens the detailed plan panel.

Persist goal state and call history across backend/app restarts without replaying uncertain actions or auto-executing work on launch. Authorized continuation while the backend runs is supported; a new service that runs after the app is closed is not included.

M24 implements these controls in the existing serialized runtime. `/goal` supplies explicit objective and optional newline acceptance bullets; workspace verification is the default, with literal human `- [observation]` opt-in for historical read-only observations. The final native request binds current goal/plan/mode revisions and exact accepted review IDs. Original step titles/identities remain protected across model removals/renames, and explicit human revisions retain visible superseded work. Failed checks persist beyond frames and unchanged criteria revisions; uncertainty persists regardless. Model summaries contain neither superseded archives nor private testcase ledgers. Bounded continuation pauses at 128 model dispatches, 256 model/queue transitions or 16 turns without newly accepted required scope. Freshness is confined observed text with explicit limits, not whole-workspace proof. See [API contract](api-contract.md#m24-durable-goals) and M24 report for exact contracts and validation evidence.

## Project instructions and tools

Read and refresh relevant bounded `AGENTS.md` before planning and affected operations. Architect can draft/create/maintain guidance describing structure, commands, conventions and durable decisions through normal version/approval protections. Keep live objectives and progress in goal storage, not a transcript in AGENTS.md. Preserve user-authored text. Planning can draft changes without mutating files.

Extend root guidance to deterministic scoped guidance with explicit priority, size/count/link bounds and current revisions. Repository guidance cannot change execution permissions, provider roles, secret handling or system-policy decisions.


## Skills

Skills are reusable workflow documents: when applicable, required context, steps, verification and expected handoff. Project skills live in `.abyssus/skills/<name>/SKILL.md`; personal skills live under the stable application home. Skills panel/native tools support draft, edit, save, discover, invoke and converting completed work into a workflow. Saving follows destination/write policies; explicit personal promotion has clear scope.



Run M22–M27 sequentially in dedicated isolated milestone chats. Coordinator reviews source and evidence independently, requests fixes, validates/pushes main and verifies applicable CI before the next dispatch. Monitor the active redesign child every 15 minutes; pause on a genuine user-assistance blocker and after the approved sequence. Work-only STARK access is known deferred acceptance, not a reason to poll credentials or block synthetic/Linux work.
