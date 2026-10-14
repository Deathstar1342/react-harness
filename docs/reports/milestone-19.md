# Milestone 19 — Independent system install decisions

Branch: `codex/milestone-19`, isolated `09ad` worktree.
Base: `c38ceae573ea7bfdf0b73548457a346992d9916d`.
Coordinator: `01a0dc0a-8866-7182-acd2-da997779962d`.
Implementation candidate and exact CI evidence are finalized in the report-only delivery update after required validation. This draft is not a delivery claim.

## Scope and contracts

M19 only: independent profile/local-target settings, minimal architect/coder advisor `recommend_packages`, durable request/decision/outcome records, existing approval UI with exact helper previews, independent bounded reviewer, on-demand history/status/reconciliation, runtime lifecycle and focused validation. No M18 production helper changes, Electron, provisioning, main integration or successor work. Coordinator approved the contract before shared changes and explicitly approved the narrow per-call reviewer no-retry transport option.

Ask is default regardless of workspace autonomy. Reviewer ID copies the critic once without changing saved chat models. Target comes only from authenticated M18 hello; a changed target resets Ask/increments revision. Separate records bind chat/project/frame/role/generation/mode epoch, policy/reviewer, recommendation, preview/digest/expiry and decision source. They survive scoped deletion. No helper descriptor/credential/decision nonce is projected to renderer/model/sandbox.

Strict helper schema/digest/impact bounds precede decisions. Reviewer gets fixed guidance plus curated untrusted evidence, no tools/transcript/extensions/capability. Existing managed critic ledger accounts a bounded 1024-token, 20-second call; `noRetry:true` travels through normal hooks/ReloadingProvider and never into upstream JSON. Ordinary provider retry defaults remain unchanged. Exactly two unique decision/reason keys are required. Failure falls back to a human only while that preview remains valid; re-preview always creates a new UUID/decision.

Final dispatch rechecks durable context after helper authorization and awaited project guidance, persists intent, and calls execute without yielding. Policy/target/reviewer changes, cancellation, steering and mode changes invalidate pending work. Dispatched effects remain truthful through cancellation. Lost replies/restart use status/reconcile only. Explicit healthy reconciliation can clear a recovery gate while retaining original uncertainty. Removal preserves protected operations/correlation. Shutdown drains actual local calls but durable historical uncertainty does not make closure impossible.

## Validation in progress

- Windows Node 24.16 typecheck/build passed; inherited large Monaco chunk warning.
- Initial full portable suite after implementation: 567 passed, one failure, 33 skips. Existing integration teardown exposed repeated install shutdown after an externally owned Store closed. Made install beginClose idempotent; focused integration passed and unchanged full suite subsequently **568 passed / 33 platform or optional skips** (00:02 EDT). Later reviewer refinements require fresh final checks.
- Focused latest service/runtime/real HTTP reviewer/provider suite: **94 passed**. HTTP 429/502/503/504 each produce one reviewer request then human fallback; ordinary default requests still make the existing maximum three attempts. Duplicate/escaped duplicate review keys reject.
- First sandboxed focused integration attempt failed on Vitest temporary module-cache ENOENT. Unchanged normal-permission run passed 41 tests. This is preserved failed evidence, not a claimed source correction.
- Background Chrome MCP inspected the real disposable UI with synthetic provider/preview and disabled helper execution. Verified exact target/version/provenance/root-impact text, Settings ordering, workspace autonomy leaving system Ask unchanged, reviewer edit, expiry and explicit fresh pending preview. No actual workstation package install or live-provider validation.
- Actual-helper Linux integration is added to the existing privileged disposable workflow: all three policy routes with `sl`, `figlet`, `toilet`, exact installed version checks, one synthetic independent review charged to the ledger, duplicate decision refusal and installed-package noop. Exact results pending; required assertions do not treat a noop as installation evidence.

## Limits and preserved environment assumptions

First source candidate `37dfd11b2192768eef6b1f63e313d3a4173c62c2`: exact ordinary [Validate 38509926653](https://github.com/Deathstar1342/react-harness/actions/runs/38509926653) passed. Privileged [38509926667](https://github.com/Deathstar1342/react-harness/actions/runs/38509926667) failed after all three M19 real installs, exact versions, noop and ledger checks passed. Existing M18 interruption observer raised `sqlite3.OperationalError: database is locked` and exited before observing/killing dpkg; the expected lost-reply assertion then failed. The fixture now closes each read connection explicitly and retries only SQLite BUSY/LOCKED observations within its existing 60-second deadline. It still requires the exact request's durable running state and actual dpkg unpack/configure argv before interruption. No production helper change or weakened acceptance assertion; fresh complete workflow remains required.

No helper/packages/services/kernel changes on the developer workstation; Podman WSL untouched. Real Linux validation uses the existing deliberately modified Ubuntu 24.04 disposable GitHub VM fixture: `/usr/share` ACL/mode normalization, distro-only loader cache, direct Ubuntu apt sources, enabled namespaces. This is not stock Ubuntu, local WSL, installed-device/Electron or work-network live STARK acceptance. Existing M18 root/OS/package trust and M17 sandbox limits remain.

No dependencies or lockfile changes. npm reports the inherited five vulnerabilities (two low, one high, two critical); no unrelated upgrades. Generated builds, credentials, local databases and user project contents are excluded. Coordinator owns independent final review, integration and main publication. Work-only live STARK remains an acceptance limit, not a user blocker.
