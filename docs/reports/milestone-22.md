# Milestone 22 — Native transport and tool registry

Candidate on `codex/milestone-22`, based on `7bee8bc66fb87a5e088ac9eda3bb565fa9c4d7b9`. Coordinator review and integration remain separate. This delivery does not start M23 or resume M21 packaging/publication preparation.

## Implementation

Chat Completions now carries complete native assistant tool calls and matching tool results. The provider supports ordinary text, text plus tools, multiple calls and indexed streaming argument fragments. It rejects refusals, truncation, missing stream completion, ambiguous IDs, malformed histories and duplicate JSON keys. Prose/fence extraction, advisor adapters and formatting repair retries are removed. No partial stream can reach execution.

The central registry owns argument/result schemas, generated provider schemas, descriptions, roles, modes, effects, risks, inspection and dispatch. Existing workspace tools retain approval, scope, version, lease, sandbox and secret boundaries. Execution is serial. Entire batches validate before effects; terminal controls must be last. Prepared dispatch checks its exact unresolved original native call before helper/workspace effects. The install reviewer uses only `install_decision`, curated evidence and no retries, with unchanged human fallback, policy and freshness gates.

Native intake, controls, result delivery and recovery preserve correlated private history/evidence. Transactions publish cached state only after commit for these transitions; fault tests exercise rollback after writes and before commit. Compaction preserves whole assistant/result groups and refuses unresolved groups. Cancellation closes unstarted work truthfully, preserves actual helper outcomes and never rolls back or replays uncertain effects. Internal coder/critic prose gets bounded continuation and then an actionable pause; architect prose remains conversation. Synthetic architect → coder → tools → critic → architect coverage exercises the connected loop.

Catalog metadata is bounded/untrusted, with unknown capabilities and credential sanitization. Connection tests separately probe ordinary replies, nonstreaming native round trips and streaming native round trips using a harmless in-memory echo. Diagnostics do not receive workspace tools. Settings displays each evidence lane. Application budgets are explicitly distinct from unknown provider limits.

Profiles/databases require `native-tools-v1`. Existing incompatible state rejects without conversion/deletion; explicit new-home initialization and same-format relocation retain lifecycle protections. Candidate model defaults are configurable `gemini-3.5-pro` for architect/critic and `gemini-3.5-flash-withtools` for coder; these IDs are not live verified.

## Interface assumptions

- `ModelMessage` is a discriminated system/user/assistant/tool union; assistant calls retain IDs, names and argument strings, and tool messages require `tool_call_id`.
- `CompletionResult` carries `text`, optional `toolCalls`, usage, finish reason and sanitized request ID. `ModelProvider.complete` accepts generated tools, tool choice, internal per-request streaming and existing `noRetry`; catalog metadata is optional for trusted test providers.
- `submit_completion` ends a work frame; coder work still requires critic review. It does not establish future M24 goal completion. `install_decision` is isolated from workspace roles.
- Public model IDs remain available; `/api/models` adds catalog entries with unknown capabilities. Connection checks add evidence/model/request ID, and public settings identify application budgets and unknown provider limits.
- Private native frame/result/identity archives preserve original correlation through compaction. Old-profile conversion and compatibility adapters are intentionally absent.

## Validation and limits

Final exact-source CI links will be recorded in the report-only handoff commit after the implementation commit is pushed. Portable Windows `npm run typecheck` and production `npm run build -- --outDir D:/CodexData/m22-validation/client-build` pass (the build retains its existing large-chunk advisory). `npm test -- --reporter=json --outputFile=D:/CodexData/m22-validation/delivery-tests.json` passes **664 tests, 0 failures, 33 platform skips**. The suite includes focused native transport, complete-group compaction, schema/role, approval/stale-write, cancellation/restart, atomicity and secret regressions. Build output and isolated test data stay outside Git under `D:/CodexData/m22-validation`.

Earlier local failures are retained there: initial conversion 572 passed / 46 failed / 33 skipped; second 606 / 12 / 33; later 649 / 0 / 33 and 658 / 0 / 33. The final boundary audit caught one planning-recovery-message regression (662 / 1 / 33), corrected without removing that safety assertion. These failures included both obsolete fixtures and actual implementation gaps; they are not represented as successful evidence.

No live STARK credentials or work-network access were used. Synthetic provider and disposable CI evidence cannot establish live model support, task quality, installed-device acceptance, native human dialog acceptance or untouched WSL support. No local privileged helper/WSL provisioning, installed-preview change, dependency version change, generated build artifact, M21/workflow/package-source edit, main merge or release publication is part of this candidate.
