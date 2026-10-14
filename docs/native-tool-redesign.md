# abysSUS native-tool redesign

Approved for implementation on 2026-10-14. This supersedes the custom JSON recommendation architecture and compatibility requirements in historical records. Implementation sequence and ownership are in [milestones](milestones.md); dispatch and verified progress are in [STATUS](STATUS.md). This document states the target, not a claim that it is already implemented.

## Product and model decisions

Chat with the architect remains central. Retain the existing quiet dark interface, editable file panel, approvals/diffs, test reports and desktop/WSL foundation. Redesign the agent core, prompts and goal/skill experience; there is no authorization for an unrelated visual rebrand.

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

## Goals

`/goal <objective>` records explicit user intent and acceptance criteria. The runtime tracks running, waiting for approval, waiting for user, paused, blocked and completed. A native response ending does not imply goal completion. When authorized work remains, the scheduler supplies current remaining scope/evidence and continues; budgets/failures have bounded, visible stopping states rather than endless retries.

Completion requests refer to a current goal/plan revision and reviewed evidence. Required steps cannot be dropped silently to manufacture completion. Keep real progress, superseded work and untested requirements visible. `/btw` steers active work; pause/resume and execution transitions remain application controls. `/goal` in plan mode does not authorize writes. A compact stable goal/phase indicator opens the detailed plan panel.

Persist goal state and call history across backend/app restarts without replaying uncertain actions or auto-executing work on launch. Authorized continuation while the backend runs is supported; a new service that runs after the app is closed is not included.

## Project instructions and tools

Read and refresh relevant bounded `AGENTS.md` before planning and affected operations. Architect can draft/create/maintain guidance describing structure, commands, conventions and durable decisions through normal version/approval protections. Keep live objectives and progress in goal storage, not a transcript in AGENTS.md. Preserve user-authored text. Planning can draft changes without mutating files.

Extend root guidance to deterministic scoped guidance with explicit priority, size/count/link bounds and current revisions. Repository guidance cannot change execution permissions, provider roles, secret handling or system-policy decisions.

Audit existing tool gaps before adding them. Priority additions are version-checked patches, line-range reads, paginated search, explicit rename/delete and structured lifecycle/output access for long-running commands. Keep current file confinement, editor leases, diff approvals, write evidence/undo and shell sandbox. New tool names never create a generic approval bypass. Commands remain potentially modifying even when named as tests.

## Skills

Skills are reusable workflow documents: when applicable, required context, steps, verification and expected handoff. Project skills live in `.abyssus/skills/<name>/SKILL.md`; personal skills live under the stable application home. Skills panel/native tools support draft, edit, save, discover, invoke and converting completed work into a workflow. Saving follows destination/write policies; explicit personal promotion has clear scope.

Discover bounded metadata first and load full selected skills only as needed. Validate schema/names/paths/UTF-8/sizes and confine references without arbitrary link traversal. Record revisions used by active work and handle changes without silently replacing its instructions. Skills guide existing tools; they cannot grant approval, register executable handlers or escape the sandbox. Model-authored workflows and developer-added capabilities are distinct.

## Delivery and packaging

Run M22–M27 sequentially in dedicated isolated milestone chats. Coordinator reviews source and evidence independently, requests fixes, validates/pushes main and verifies applicable CI before the next dispatch. Monitor the active redesign child every 15 minutes; pause on a genuine user-assistance blocker and after the approved sequence. Work-only STARK access is known deferred acceptance, not a reason to poll credentials or block synthetic/Linux work.

M21 packaging remains paused: preserve `codex/milestone-21`, worktree `6fd9`, its uncommitted source/license changes and failed/successful receipts. Do not merge that unfinished work into redesign. M27 validates the existing packaging integration against redesigned code; source-bundle/final release work resumes only after the redesign is delivered. Unsigned, clean-machine, native-picker, OS-auth, privileged-close and live-provider gates stay explicit. No release or installed-preview update is implied by implementation delivery.

Use D: for large builds, fixtures and caches because C: is constrained. No local privileged package/helper installation or WSL/global configuration changes; use disposable CI/VMs. No Docker/SSHFS, native Windows agent-shell fallback or new numbered milestone beyond M27 is authorized. Never commit supplied private API documents, secrets, runtime data, user project contents or generated binaries/source archives.
