# Milestone 23 — Versioned role prompts and native orchestration

Candidate branch `codex/milestone-23`, isolated worktree `b10a`, exact kickoff `9d9f7793c07546d3eb5b5058d3418d957345db30`. Coordinator review/integration remains separate. No M24 goal persistence/continuation, M25 tools/guidance maintenance, M26 skills, main merge or release is included. M21 and its separate uncommitted work remain paused.

## Implementation and interface assumptions

- Server-only versioned fixed policy, common contract and architect/coder/critic modules replace `server/protocol.ts`. `roleInstructions` composes them with a bounded optional developer extension; the tool registry remains the schema authority. Existing fixture imports use the new module, without a compatibility adapter. The separate install reviewer is unchanged.
- Architect responsibilities cover original requirements, bounded delegation, plan maintenance, routine decisions, review cadence, real blockers and truthful outcomes. Coder and critic prompts require actual evidence, original acceptance, manual-edit protection and independent native verdicts. Normal architect conversation remains valid. Status updates, assignment completion, checkpoint/phase scope and whole-goal completion are explicitly distinct.
- Private original `Frame.assignment` survives compaction; current association can be superseded without erasing original criteria. Private current-task `RunState.humanMessageIds` identifies actual stored human requests/steering and survives Start building. Internal `role:user` review/summary evidence is never relabelled as human constraints. Fresh project guidance, original assignment/human context, structured remaining-plan/review state and untrusted transcripts remain separate. Protected context over budget fails explicitly rather than silently truncating criteria.
- Private `context:prompt:<chat>:<frame>:<step>` records module versions and the actual composed system-prompt SHA-256, role/model, generation and guidance hash immediately before a role request. No extension text/path or these records are public settings/events. No new public DTO, SQLite table, dependency, provider transport, helper authority or UI feature.
- Native batch validation, serial execution, terminal-last controls, whole compaction groups, original call/result correlation, complete argument/result validation, bounded internal prose, approval/mode/version/lease protections and uncertain-operation no-replay remain in place. New ledger/result/review changes publish cloned state only after COMMIT. Before-start rejection now carries explicit `not_started` evidence; recovered modifying execution retains uncertainty.

## Narrow assignment verification gate

The critic's raw verdict stays recorded. Plan acceptance additionally requires the existing matching delegation/final/current mode/plan reference and observed tool evidence, plus no known assignment verification blocker. This is not a whole-goal gate or semantic proof of all requirements.

Each `run_tests` check has an exact canonical argument digest within its delegation. Matching is deliberately conservative: command, timeout and report-path changes do not silently clear old check obligations. Arguments identify the request, **not coverage**. Actual classname/name identities and duplicate multiplicities accumulate from recorded reports. Previously observed cases cannot disappear; previously non-skipped cases must actually pass. A successful result/exit-zero/report with at least one passed case and no failed/error cases can include ordinary optional skips, which remain disclosed. All-skipped, empty, unavailable or error reports are incomplete evidence, distinct from a nonzero command exit. Failed full coverage cannot be cleared by a narrower passing command or a same-command reduced report. Original failure/report events remain intact.

Private scoped snapshots use existing confined read/list over explicit assignment paths: at most 128 entries, depth 8, 1 MB and two seconds. Absent/empty/oversized/unreadable/binary scope is unknown, not a false unchanged-workspace claim. Only the fixed default `.react-harness-test-results.xml` is excluded; custom report paths and generated-looking directories are not ignored. Before/after test snapshots and completion-review rechecks bind to the same frame/assignment/generation/mode. Stable independent checks coexist. A test that changes inspected source, a later potentially modifying write/shell/Python command, or a manual edit before review stales earlier verification. Unknown or changed scope cannot be cleared by PASS.

The ledger is bounded to 100 checks, 100 uncertain effect IDs and 10,000 hashed testcase identities globally per assignment; overflow fails closed. Repairable findings have two bounded repair attempts. Uncertain/interrupted-after-dispatch effects return to the architect without automatic retries. Cancelled/denied-before-start work is not an uncertain effect. Read-only assignments and expected nonzero discovery probes are not forced into failed-test semantics; unrelated historical events do not contaminate an assignment.

Limits: snapshots cover visible regular text in the explicit scope, not filtered entries, outside-scope dependencies, persistent shell cwd/environment, test authenticity or external race freedom. Exact arguments and report names cannot prove those properties. The critic still evaluates missing requirements and whether chosen checks suffice. A new assignment does not reconcile or erase historical uncertainty. Runtime acceptance language says no known blocker in observed evidence, not complete workspace proof. Context-budget failure is possible for large original assignments/human constraints; no silent dropping is allowed.

## Deterministic evaluation matrix

`tests/orchestration-fixture.ts` is a small reusable provider/command scenario fixture using the actual Runtime, SQLite store and confined file tools. Command outcomes and the provider are synthetic; no host-shell execution or live-STARK quality is implied. `tests/orchestration.test.ts` contains 28 cases.

| Scenario | Observed assertion |
| --- | --- |
| Eight phases, premature conclusion after phase two | Two associated steps accepted; six remain pending and appear in next-request state. Frame can end; M24 continuation is not implemented. |
| Failed/missing/all-skipped verification, unsupported PASS | Matching step blocked, actual exit/report truth retained, bounded repairs. |
| Failed full check then narrow pass / later matching pass | Narrow check cannot resolve failure; a later complete matching check can. |
| Same command with removed, skipped or duplicate-reduced cases | Coverage remains blocked. Mixed pass/optional skip is valid within disclosed observed coverage. |
| Test modifies inspected source; independent stable checks | Earlier passes stale after mutation; both independent checks can complete after stable verification. |
| Manual edit after tests / stale edit attempt / scope drift | Review freshness catches edit; stale write preserves manual bytes; out-of-scope write does not occur. |
| Missing README / empty repository / unchanged failing discovery | Observations can lead to authorized creation; repeated failed actions reach checkpoint review without accepting completion. |
| Steering during provider request or pre-test snapshot | Old association superseded; unstarted test is not dispatched; original criteria and new human constraint retained. |
| Checkpoint versus completion | Checkpoint verdict does not accept assignment; matching completion review does. |
| Repository/internal-summary injection / plan-only | Fake human/system labels do not grant tools, create delegation or release planning. Compacted malicious summary cannot replace original criteria. |
| Uncertain or interrupted effect / denied before start | No replay or PASS-based reconciliation; denied work is not uncertain execution. |
| Private prompt identities / UTF-8 extensions | Recorded digest matches each actual system prompt; extension cannot expose critic execution/install tools. |
| Ledger write/COMMIT faults | Cached and durable ledger, native history, progress and events roll back together. |

These scenarios test supplied context and runtime responses to scripted model behavior. They do **not** show that the actual work-network model chooses good delegations, avoids unchanged discovery, notices semantic scope drift or consistently follows the prompts. Live STARK role quality, realistic long-task behavior, actual provider capability and human/device acceptance remain separate deferred evaluation lanes. No credentials were requested or polled.

## Validation and retained failures

Portable Windows Node 24.16.0: typecheck and production client build passed. Full refined suite passed **724 tests / 0 failures / 33 platform skips**. A final small empty-scope safeguard then passed the focused **28 scenarios** and typecheck. Build artifacts and disposable fixtures remain outside Git under physical `D:/CodexData/.codex/visualizations/2026/10/14/01a13c55-6615-7373-8241-5fda456877c2`; the existing large Vite chunk advisory remains.

Retained receipts there: `initial-focused.json` (201 passed / 3 failed / 1 skipped: sandbox-denied link/junction fixtures plus a compaction fixture whose small input budget needed to include the new role policy), `scenarios-first.json` (144 / 2 / 1: test filtered started tool events as though all were outcomes, and too-small compaction fixture budget), `scenarios-second.json` (16 / 1: synthetic critic incorrectly returned coder completion, causing a bounded-loop fixture timeout), `full-first.json` (713 / 0 / 33 before coverage/snapshot refinements), `coverage-first.json`, `snapshots-first.json`, `full-refined.json` and `final-scenarios.json`. Fixture corrections preserved the safety assertions. Normal Windows access resolved link/junction setup without changing production safety behavior. All required exact-source Linux/Electron/helper CI lanes are still pending publication at this checkpoint.

No local WSL/privileged helper provisioning, installed-preview change, global configuration change or actual device/auth-dialog acceptance occurred. Disposable Linux/PTY/Electron/helper evidence will be recorded separately from portable Windows checks. Automatic installer workflow execution is not a resumed M21 release or packaging acceptance claim.
