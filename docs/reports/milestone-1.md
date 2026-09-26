# Milestone 1: provider and versioned action protocol

Implemented on `codex/milestone-1`, based on foundation `c976a6f1e2b91a64fed9e8b907f2e92ad066659a`.

Managed worktree: `C:\Users\joshu\.codex\worktrees\milestone-1\REACT harness` (the host resolves its junction under `D:\CodexData`). Coordinator owns integration; this milestone does not merge main.

## Delivered

- `server/provider.ts`: `StarkProvider` implements the unchanged `ModelProvider` contract with ordinary fetch requests to `/models` and `/chat/completions`. Supports streaming/nonstreaming, optional token limit, usage, and model discovery. No native tools or response_format fields.
- Incremental bounded SSE decoding supports arbitrary byte chunks, split UTF-8, LF/CRLF/CR terminators, multiline data, comments, usage frames, and stream error events. Successful streaming requires `finish_reason: stop` and the complete `[DONE]` event. EOF without either, length termination, malformed payloads, native-tool output, and refusal fail closed.
- One timeout spans headers, response body, and retries. AbortSignal propagates cancellation without exposing supplied abort reasons. Reader cancellation, timeout cleanup, and external listener removal run on success and failure. Cancellation from the final delta also prevents success.
- At most two retries (three HTTP attempts) for 429/502/503/504 before response consumption. Retry-After is honored within the operation budget. Network failures, malformed bodies, and interrupted output are not replayed. Redirects are rejected to avoid forwarding authorization unexpectedly.
- Provider errors contain controlled messages/classifications and optional HTTP status; they never retain upstream error bodies, response excerpts, secret-bearing URLs, raw causes, or abort reasons. Credentials are private fields and absent from request payloads.
- `server/protocol.ts`: strict bounded Zod schemas for every documented envelope/action, plus the coordinator-requested `review_result` with `{ verdict: 'pass' | 'changes_requested', findings: string[] }`. Unknown fields, absent hashes, invalid timeouts, duplicate plan IDs, malformed/truncated JSON, and unsupported actions are rejected. No partial action execution.
- Role-specific architect/coder/critic instructions require truthful evidence and structured action requests. The critic concludes with review_result. Optional bounded application guidance is available without changing required call sites.

## Validation

Windows, Node.js v24.16.0, installed from the existing package lock with `npm ci` (zero audit vulnerabilities reported):

- `npm run typecheck`: passed.
- `npm test`: 117 tests passed across three files, including the foundation configuration tests.
- `npm run build`: passed.
- `git diff --cached --check`: passed before commit.

Local mock HTTP tests exercise authorization/header/request shape, models, nonstreaming responses, one-byte SSE writes and UTF-8, CRLF/multiline data, CR-only framing, usage, refusals, length/EOF truncation, stream error bodies, invalid content, redirect rejection, bounded retries, Retry-After, cancellation before/during/at final output and backoff, header/body timeout, listener/timer cleanup, socket failure without replay, and output bounds. Protocol tests cover all actions and invalid argument families, every prefix of an executable write action, strict unknown-field rejection, bounds, and redacted validation errors. A complete-looking streamed JSON action followed by truncated transport never reaches the mock executor.

## Integration notes

- Required exports/signatures unchanged: `new StarkProvider({baseUrl,apiKey,streaming?,timeoutMs?})`, `complete`, `models`, `parseAgentResponse(text)`, and `protocolInstructions(role)`.
- Additional exports: `StarkProviderOptions`, `ProviderError` (`code`, optional `status`), `ProtocolError` (`code`), `actionSchema`, `agentResponseSchema`, `planPhaseSchema`, `ValidatedAction`, and `PROTOCOL_LIMITS`.
- `protocolInstructions(role, extension?)` accepts optional trusted application guidance up to 32,000 characters. It does not perform provider-policy evasion.
- Missing provider credentials/base URL are rejected when requesting a model, so an unconfigured application can still initialize its backend.
- Deltas are provisional presentation data. Execute only after `complete` succeeds and `parseAgentResponse` returns a validated envelope. Do not parse/execute per delta or retry an uncertain runtime action because a provider request failed.
- Schema validation is not authorization. Runtime must enforce role restrictions, /plan, approvals, file scopes, baseHash freshness, and action deduplication. Only the architect may delegate; only the critic may submit review_result. Workspace tools remain responsible for path confinement, symlinks, leases, stale-write checks, and shell effects.
- Coordinator requested review_result during implementation and owns the corresponding API documentation update. No shared types, API contract, root configuration/dependencies, coordinator status, UI, or other milestone files were changed.

## Limitations and acceptance gates

No live STARK credentials were available, so actual endpoint/model availability and provider-specific streaming behavior are unverified. Providers that omit the conventional stop or [DONE] terminator are intentionally rejected until their behavior is validated explicitly. Linux/WSL runtime, PTY, browser, and end-to-end orchestration were not tested by M1; its checks were portable Windows tests against local HTTP servers. No user assistance blocker remains for implementation. Integration and live-provider acceptance remain with the coordinator.
