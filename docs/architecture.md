# Architecture and implementation plan

## Product direction

Build a local browser application with a Node.js/TypeScript backend running in WSL. Chat with the architect is the primary interaction. Files, diffs, plans, terminal output, and test results are optional supporting panels.

This is a fresh implementation. There is no dependency on the previous Streamlit/FastAPI application or its tools.

## Provider contract

- Use only `/models` and `/chat/completions` on a configurable STARK-compatible base URL.
- Keep the API key in backend environment configuration; never expose it to the browser, logs, or child shell environments.
- Use streaming ordinary text and a versioned JSON action protocol. Do not require native `tools` or `response_format` support.
- Keep prompts configurable and validate actual provider behavior early.
- Buffer complete actions before schema validation and authorization. Partial streamed JSON cannot execute.
- Distinguish malformed output, refusals, truncation, transport errors, and valid actions. Bound retries and avoid duplicate execution.
- Persist execution identifiers and outcomes. Reconcile uncertain side effects after interruption rather than blindly replaying them.

Default model assignments are architect `gemini-3.1-pro-preview`, coder `gemini-3.8-flash`, and critic `gemini-3.6-flash`.

Google publishes input limits of 1,048,576 and output limits of 65,536 tokens for each model. These are configurable capacity limits, not target request sizes:

- [Gemini 3.1 Pro Preview](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview)
- [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
- [Gemini 3.6 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash)

## Agent coordination

The architect owns user interaction, requirements, plan revisions, delegation, steering, and final reporting. `/plan` requests planning without execution. Small tasks do not require elaborate phases.

Coders receive bounded objectives, relevant context, file scope, and acceptance criteria. Begin with one coder. Add parallel execution once workspace isolation and integration are reliable.

The critic inspects actual diffs and verification evidence against user intent and acceptance criteria. Trigger reviews at phase completion, before final delivery, after repeated failures, and when scope expands. Bound repair/review cycles.

The runtime owns task status and permissions. Model prose cannot authorize an action or mark an unverified test as passed.

## Workspace and tools

Provide file read, list, search, patch/write, local Git operations, shell execution, and Python execution through the local tool service. Create a Git repository for a new project. Preserve existing repositories and uncommitted work when importing projects.

Use independent persistent PTY sessions for active coders so `cd`, activated environments, and shell state persist between their commands. Serialize access within a shell; track command boundaries, exit status, cancellation, and background processes. Browser reconnects attach to existing backend sessions.

Backend restart recovery may recreate shells and working directories, but must not claim to restore arbitrary shell memory or dead processes.

Parallel coders may use Git worktrees. Validate changes against the current integration destination before applying them. Chats sharing a workspace receive change notifications and obey common write coordination.

## File editing and approvals

Every read returns a file version. Every edit references the version it was based on. Recheck immediately before applying; reject stale proposals and require a refreshed edit. Protect unsaved editor buffers and observe external saved changes. Propagate relevant manual-change diffs to affected agents.

Approval modes:

| Mode | Behavior |
| --- | --- |
| Full workspace autonomy | Permit actions within configured workspace and execution permissions |
| Balanced | Permit routine edits and configured checks; request approval for installs, expanded access, and designated actions |
| Review every change | Permit reads; request approval for writes and potentially modifying commands |

File approvals display the current-to-proposed diff and are bound to the exact proposal and file version. Changes invalidate stale approvals.

Shell execution must obey the same policy. Arbitrary commands cannot have a guaranteed predicted file diff. When a pre-application diff is required, execute in an isolated workspace and review the resulting changes before integration. A working directory alone does not enforce filesystem confinement.

## Persistence and context

Use SQLite plus artifact storage for projects, chats, messages, plans, tasks, tool calls, approvals, file versions, summaries, and test reports. Preserve original transcripts and large output artifacts for retrieval.

Use model-written continuation summaries independently for architect and coder contexts. Preserve goals, decisions, constraints, outstanding work, and evidence references. Reattach authoritative task state, recent steering, pending approvals, and file versions separately from the model summary.

Compact before exhausting input capacity, with room for instructions, output, and tool results. Use conservative estimates when provider token counting is unavailable. Do not infer infinite memory from a large context window.

## Steering and scheduling

- `/btw` delivers additional guidance at a safe boundary, with a visible delivery acknowledgement.
- Interrupt cancels generation where possible and blocks new tool actions before returning control to the architect.
- Pause/resume persists task state. Cancellation does not undo completed side effects.
- Propagate steering to affected coders and invalidate obsolete pending actions.
- Ordinary Chat Completions requests cannot receive newly inserted messages mid-generation; cancel and restart or wait for completion.

Coordinate all roles through a shared scheduler. Initial configurable account budgets are 120 requests/minute, 1,500,000 tokens/minute, and 150,000,000 tokens/day. Reserve capacity for user interaction, steering, and compaction. Handle provider throttling and track estimates versus reported usage.

## Interface and test reports

Left sidebar: projects and chats. Center: architect conversation with collapsible activity and approval cards. Optional right panel: files, editor, and diffs. Collapsible plan panel: phases, steps, owners, blockers, and verification. Bottom drawer: shells and tests.

Use structured test reports, beginning with pytest JUnit XML, rather than model interpretation of console text. Display runner, individual runs, test cases, status, traceback, and captured output. Distinguish skipped cases, failures, collection errors, cancellation, and runner crashes.

## Delivery sequence

1. **Provider and protocol:** model discovery, text streaming, schema validation, bounded error handling, and configuration. Verify malformed or partial actions never execute.
2. **Durable agent loop:** architect delegates to one coder and reports evidence; reopening restores conversation and task state without duplicate actions.
3. **Workspace correctness:** file tools, version checks, approvals, persistent shells, execution controls, and manual-edit protection. Verify stale edits and approvals are rejected.
4. **Complete chat UI:** projects, chat selection, editing/diffs, plans, steering, cancellation, and reconnection.
5. **Critic and verification:** evidence-based reviews, bounded repair, structured test results, and accurate completion reporting.
6. **Parallelism and delivery:** isolated coder workspaces, integration checks, concurrency tuning, startup documentation, and recovery tests.

The first end-to-end milestone is a persistent architect conversation that delegates to one coder, proposes an approved file change, applies it, returns the result, and survives reopening.

Follow-on features include selective undo that preserves unrelated manual changes, project instruction files, configurable execution budgets, and an agent activity timeline.
