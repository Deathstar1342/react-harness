# Milestone 8 — Settings and focused chat

Implemented on `codex/milestone-8`, based on coordinator commit `9a7514f8f2fead48800368e0e7a9224b099673f1`. The exact delivery commit is reported in the coordinator handoff. Integration, main publication, milestone closure and M9 dispatch remain coordinator-owned.

## Delivered behavior

- Settings offers Test connection with explicit per-catalog/per-role pass, fail and not-checked results. It checks exact configured model IDs and runs small final-response probes through the normal provider and managed account scheduler. No probe reply enters a chat or executes an action. All report text is fixed and sanitized, including unknown exceptions and parser failures.
- Checks are serial within one backend-wide check, limited to three completion attempts and 1024 output tokens per attempt (capped by configured output maximum). The 25-second total deadline includes catalog retrieval and account queue waits. Existing transport byte/stream bounds remain in force; diagnostic text parsing adds a 2048-character bound. Client cancellation, Settings unmount, HTTP disconnect and server shutdown stop the check; the client has a separate 30-second upper bound. No retry loop was added.
- Approval controls moved out of the composer into Settings. Current-chat mode and the future-chat default are separately labelled and saved. The server rejects policy changes while running, awaiting approval or holding pending proposals. Changes neither release proposals nor resume runs. New chats request the authoritative server default rather than a stale frontend copy.
- Debug is persisted in the existing SQLite state table and defaults off. The normal conversation keeps user/architect/system messages, failed tool messages, event-only errors, exact approvals/diffs and structured test evidence. Internal coder/critic/successful-tool messages and the Activity trace are available with Debug on. Duplicate error events already represented by visible messages are omitted. Provisional activity wording is role-neutral.
- Settings explains that approval and Debug controls save immediately. Workspace selection retains its explicit Save workspace action and Close does not imply rollback of saved preferences. Existing editor mounts, dirty-buffer leases, project navigation and resize/expand implementation are preserved. No JSON/streaming toggles or dependencies were added.

## Interface changes

Documented in `docs/api-contract.md` and `shared/types.ts`:

- New `Preferences`, `ConnectionCheck`, `ConnectionReport` types.
- `GET/PATCH /api/preferences` persists `{debugMode, defaultApprovalMode}` backend-wide using strict partial updates. Defaults are Debug false and configured APPROVAL_MODE.
- `POST /api/connection-check {}` returns a sanitized report; check failures use 200/ok:false, concurrent checks use 409, shutdown rejects new checks with 503. Existing local host/origin and JSON-body controls apply.
- `GET /api/settings.approvalMode` and omitted `POST /api/projects/:id/chats.approvalMode` reflect the persisted default.
- `PATCH /api/chats/:id.approvalMode` returns 409 for an actual policy change while work/proposals are active. This is a deliberate contract tightening.
- No changes to runtime action schemas, security/tool modules, dependencies or database schema. Catalog GET is bounded but is not a token-bearing completion reservation; all completion attempts use the existing account ledger, including conservative uncertain charges on failure/cancellation.

## Validation

Node.js 24.16.0 on Windows, after final coordinator review fixes:

- `npm run typecheck`: passed.
- `npm test`: **284 passed, 10 skipped** (19 test files passed, two platform-dependent files skipped).
- `npm run build`: passed; existing large Monaco chunk warning remains.
- `git diff --check`: passed.
- 39 new focused cases cover exact/missing model IDs, actual synthetic HTTP streaming and nonstreaming transports, managed role/account usage, output/account caps, format/action/refusal/auth/rate/truncation failures, no raw reply/key disclosure, duplicate checks, total deadlines including queue waits, ignored cancellation, real HTTP disconnect, shutdown, persistence/restart and settings scope, invalid/origin requests, pending approval preservation, focused-chat error deduplication, tests/approval availability and client cancellation.

The initial full run found the M6 `/plan` test expected a policy PATCH to succeed while awaiting approval. Coordinator explicitly approved changing only that test: assert 409 while pending, pause through runtime control, switch to autonomy, then retain the original `/plan` mutation-prohibition assertions. Final full-suite result above includes that updated regression.

## Limits and coordinator review notes

- No live STARK call was made. Synthetic providers exercise real transport, parsing, scheduler and HTTP behavior but do not establish work-provider compatibility or general model task quality.
- Browser automation/visual interaction remains unverified because the existing saved-permission block was not bypassed. UI checks use server-rendered markup and request/filter contracts; they do not establish click, keyboard, layout or Monaco device acceptance.
- Native Windows portable checks do not establish real Linux PTY behavior. Ten platform tests remain skipped locally; Linux CI owns those checks. WSL/Podman distributions were not changed.
- Debug preferences are backend-wide and loaded at app initialization/Settings open; changing another tab's preference does not live-broadcast a UI update to already-open tabs. New-chat approval defaults are always read on the backend at creation.
- A 25-second diagnostic deadline can time out on a slow or busy provider. A timeout is shown as a failure with remaining roles not checked, never as a format failure or successful connection. Failed/aborted attempts may still consume provider/account budget.
- No user assistance is required for this delivery. Remaining integration/CI/browser/live-provider acceptance decisions belong to the coordinator and owner.
