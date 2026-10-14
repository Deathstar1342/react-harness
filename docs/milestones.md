# Delivery milestones

## Active M22–M27 native-tool redesign — approved 2026-10-14

User approved implementation with "boom lets do it! document the redesign and milestones, then start M22". The revised [redesign](native-tool-redesign.md) supersedes earlier no-native-tools, preserve-advisor-wording, legacy-profile and no-successor instructions. Run **M22 -> M23 -> M24 -> M25 -> M26 -> M27** sequentially in dedicated **Milestone x** chats and isolated `codex/milestone-x` worktrees from reviewed/published main. Coordinator independently reviews each delivery, requests corrections, validates integration, pushes GitHub main and verifies applicable CI before dispatching the next milestone. Child tasks may commit/push their assigned branches; they do not merge main, close milestones, publish releases or start successors.

Resume the existing 15-minute heartbeat for this redesign only. Check compact child status when no report has arrived, assist routine stalls and decide routine contracts as coordinator. Pause immediately when user information/manual assistance is truly required; known work-only STARK access is not an implementation blocker. Report provider, portable, Linux/PTY, browser/Electron and installed-device evidence separately. Keep M21 packaging paused throughout redesign; preserve worktree `6fd9`, branch `codex/milestone-21`, uncommitted source/notices work and original receipts. M27 validates existing desktop packaging against the redesign but does not resume M21 source-bundle/release work. After M27, return to the coordinator for M21 resumption with all remaining acceptance explicit; no additional numbered milestone is authorized.

### M22 — Native transport, capabilities and central tool registry

Reviewed delivery on 2026-10-14: handoff `ff18d12`, tested source `6ee864e`. Independent coordinator checks passed 696 Windows tests / 33 skips, typecheck, desktop build and real Windows Electron smoke/restart/crash recovery. All required exact-source Validate/Desktop Windows+Ubuntu/helper steps are green. Integration publication and exact-main CI remain required before M23 dispatch; live STARK and native manual/device acceptance remain separately pending. See STATUS and [coordinator review](reports/milestone-22-coordinator.md).

- Replace text-only provider contracts with complete native assistant/tool-call/tool-result messages. Support ordinary replies, tool-only replies, text plus tools, multiple calls, streaming argument fragments, matching call IDs, usage and sanitized request tracing. Correctly handle tool-call finish reasons, refusals, truncation, duplicate/conflicting IDs, unknown names, invalid/bounded arguments and cancellation. Execute no partial stream and no call from prose.
- Define each tool once: name, description, argument/result schema, roles, modes, effect/risk, inspection and handler. Publish provider schemas and validate execution from that definition. Retain permission checks at execution, not just tool advertisement. Propose concrete exported interfaces early; no new dependency without review.
- Connect existing workspace/control tools to the native loop in one functional delivery. Remove legacy envelopes, advisor normalization, JSON/prose/fence extraction, format-repair prompts and retries, including connection-test assumptions. Provide minimal correct native role instructions; M23 owns their deeper redesign. Migrate the isolated install reviewer to a dedicated native decision tool with its curated evidence and unchanged policy/freshness/fallback protections.
- Persist native call/results and pending execution intent. Preserve complete call/result groups during compaction; restart/cancellation/steering cannot replay uncertain operations or supply orphaned results. Serialize execution even when several calls are returned. No parallel coders or concurrently mutating batches.
- Upgrade catalog/connection diagnostics with explicit unknown capabilities and harmless in-memory tool/result round trips. Test ordinary, native and streaming behavior independently, capture sanitized capability/request evidence. Never assume plain IDs or suffixes work; document provider catalog inconsistencies. No JSON/streaming toggles in ordinary settings, no Responses dependency, no legacy fallback.
- Require a fresh protocol/profile format for the prototype; old-profile conversion is out of scope. Detect incompatible state without erasing user data. New-chat model snapshots remain supported. Coder default is a documented Gemini3.5 Flash tool-capable candidate; exact architect/critic3.5 Pro IDs and3.8 Flash selection remain configurable, unverified live here.
- Own scoped `shared/types.ts`, provider/protocol replacement/registry, runtime/tools/context/scheduler/store/config/diagnostics/install-review wiring, affected UI contracts only as necessary, tests and relevant API/setup/architecture docs plus `docs/reports/milestone-22.md`. Do not edit M21 packaging/workflows/source bundles, goals/skills UI, coordinator STATUS or dispatch records. Existing privileged CI can validate changed review integration in disposable Linux; no local provisioning.
- Acceptance: typecheck/full tests/build and focused native streaming/tool-round-trip/role/approval/stale-write/compaction/restart/steering/secret tests pass; applicable Linux CI passes. Demonstrate a synthetic architect -> coder -> tools -> critic -> architect flow. No production references to the removed parser or hidden compatibility mode. Live STARK acceptance remains separately pending.

### M23 — Role prompts and native orchestration

- Move role prompts into versioned modules. Give the architect ownership of requirements, plans, scoped delegation, review cadence and routine decisions; distinguish user updates from task/phase/goal completion. Coders implement verifiable assignments and critics inspect actual evidence with explicit verdict tools.
- Remove repetitive schema instructions from prompts; keep tool descriptions focused and role/mode exposure minimal. Fresh project guidance, user steering and authoritative runtime controls remain distinct. Critic/install-review models cannot gain execution authority.
- Maintain `planStep`/plan-version associations, bounded repair/review cycles and truthful progress. Evaluate long plans, early completion, missing files, failures, scope drift, manual edits and unchanged discovery loops with meaningful fixtures; no fabricated claim that live-model behavior passed.
- Own prompts/native orchestration/context, focused tools/tests/docs and its report. No `/goal` persistence or skills authoring yet. Deliver typecheck/tests/build and applicable Linux evidence.

### M24 — Durable goals and completion gates

- `/goal` records an explicit objective and acceptance criteria. Runtime states cover running, waiting for approval, waiting for user, paused, blocked and completed. Native end-of-turn is not goal completion; schedule the next useful turn when required work remains and controls permit it.
- Bind goal/plan revisions, reviewed evidence and explicit completion requests. Scope cannot be quietly reduced to hide unfinished requirements. Preserve `/plan` execution authorization, `/btw`, cancellation, approval/version checks, budgets and uncertain-operation protection. Budget/failure pauses have precise reasons; avoid automatic unbounded retry loops.
- Store goal state across restarts and show a compact goal/phase indicator with details in the collapsible panel. Restore state without replay or silently resuming side effects on app launch; continuation while the backend remains running is supported, app-closed background services are out of scope.
- Own goal schema/store/runtime/API/UI/commands/context/tests/docs/report. Test an eight-phase goal, early stop after phase two, blocking/approval, pause/resume, edits/steering, revisions, crash and completion evidence.

### M25 — Project instructions and precise workspace tools

- Architect reads, drafts and maintains bounded `AGENTS.md` guidance: project structure, commands, conventions and durable decisions. Goals/live task status stay in the database. Preserve user-written guidance with version-checked edits and normal approval rules; planning can draft but cannot write without execution authorization.
- Support deterministic scoped instruction loading with documented priority, bounds and link safety, refreshed before affected operations. Repository text cannot grant permissions or alter native message roles.
- Add useful version-checked patches, line-range reads, paginated search, explicit rename/delete, and structured start/status/cancel/output for long commands as justified by audited tool gaps. Use the registry; preserve dirty buffers, diff approvals, private output and shell lifecycle. Each new mutation gets meaningful boundary tests.
- Own scoped instructions/tools/runtime/UI/API/tests/docs/report. No arbitrary host filesystem capabilities or parallel write execution.

### M26 — Reusable skills

- Project `.abyssus/skills/<name>/SKILL.md` and personal application-home skills describe reusable workflows, not new execution authority. Discover bounded metadata, load full text only when relevant, and record the revisions used by active work.
- Skills panel and native tools create/edit/save/invoke skills, including "turn this task into a skill". Apply existing write/approval rules; explicit personal promotion has a clear destination. Validate names/paths/frontmatter/size and reject unsafe links. Skill text cannot grant approval, install handlers or override runtime controls.
- Own skills storage/catalog/loading/tools/UI/API/context/tests/docs/report. Test drafting/saving, explicit invocation, revisions, restart/compaction, malformed paths/metadata and instruction/permission conflicts.

### M27 — Integrated evaluation and redesigned desktop validation

- Verify the complete native workflow with goals, project guidance, skills, editor conflicts, reviews, package policies, steering and restart. Audit removal of obsolete parsing and prompt-format machinery, schema consistency and failure presentation.
- Commit a runnable bounded work-side diagnostic and sanitized output/report format; verify exact IDs, native round trips and streaming at work when the user can run it. No secret polling or live acceptance claim from mocks. Account for rate/credit headers, key locking and retired models without arbitrary returned links becoming trusted navigation.
- Validate existing Electron packaging/build/lifecycle against the redesigned source in disposable environments and retain all native/manual release gates. M21 packaging correction and final publication remain paused until this delivery; do not borrow its unreviewed edits, publish artifacts as accepted or silently waive gates.
- Own integration/evaluation/diagnostic tests, scoped CI corrections, acceptance/setup docs and report. Coordinator decides final integration and later M21 resumption. No M28 authorized.

Each delivery reports SHA, changed interfaces, meaningful tests, exact CI/artifacts where applicable and explicit limits. The user authorizes commits/pushes and coordinator/child messages throughout this sequence. Do not commit private provider documentation, credentials, runtime databases, project contents or generated artifacts.

## Historical M16–M21 desktop sequence (2026-10-13)

User approved implementation of this plan with "boom get started!" on 2026-10-13: Electron packaging, Docker-free Linux process sandboxing, and a privileged system-install helper provisioned during setup. System-install policy is separate from workspace approvals: Ask every time (default), Auto-approve, or AI review. This authorization supersedes the older executable-packaging and discussion-only holds. Start M16 and resume the existing 15-minute heartbeat; current dispatch is recorded in STATUS. Detailed architecture, platform assumptions and boundaries are in root [EXE.md](../EXE.md).

Planning baseline: GitHub main `57b2099`, including the user's latest advisor prompt edits and restored `planStep` guidance. Preserve those changes and all M12–M15 protections. No Docker/SSHFS, native Windows agent shells, parallel coders or unrelated redesign in this sequence.

### Workflow and dependencies

When implementation is started, run **M16 → M17 → M18 → M19 → M20 → M21** sequentially. Each gets a dedicated chat named exactly `Milestone x`, an isolated `codex/milestone-x` worktree from reviewed main, an explicit scope and `docs/reports/milestone-x.md`. Children propose shared/API/security contracts before changing them, commit and report the exact SHA/evidence/limitations, then remain idle. They never merge main or start the successor.

Coordinator independently reviews source and evidence, requests corrections, runs integration checks, pushes **GitHub main**, verifies exact applicable CI, then starts the next chat. Coordinator owns STATUS, dispatch and milestone records; routine implementation decisions do not need a user round-trip. Preserve all earlier branches/worktrees and user data. Resume the existing 15-minute heartbeat only when work starts; stay quiet when unchanged, assist routine stalls, pause immediately for genuine user assistance and after sequence delivery. No live STARK credential polling. Do not invent implementation evidence for packaging, WSL, privileged operations or physical-device acceptance.

First release planning target: Windows x64 Electron UI with a supported Ubuntu/Debian WSL2 backend, and a Linux x64 desktop build on a supported Ubuntu/Debian release. Validate exact OS/distribution versions before freezing the release matrix. Native Windows host installs, other package managers, macOS and ARM are deferred, not silently emulated. No automatic WSL distribution installation/reconfiguration; missing prerequisites get explicit setup guidance. These are coordinator defaults for a bounded first release, not claims of current support.

### M16 — Durable application home and backend lifecycle

Delivered on GitHub main `9a44265` on 2026-10-13: candidate `990a8e8`, merge `0b870f0`. Independent Windows checks passed (515 tests, 15 platform skips); exact main Linux CI passed [run 38498238317](https://github.com/Deathstar1342/react-harness/actions/runs/38498238317). M17 dependency released. Detailed evidence and limits: [M16 report](reports/milestone-16.md).

- Separate installation files, persistent configuration/state, project folders and sandbox dependency/cache directories. Choose a stable platform-native home with an explicit override; startup must not depend on the launch directory. The Linux/WSL backend owns its state in its selected environment; Electron must not copy the database across Windows/WSL on each launch.
- Preserve explicit existing environment overrides. Discover known legacy `.harness`/`.env` locations without scanning arbitrary personal files; migrate only an identified source. If multiple profiles exist, let the user choose rather than merge or start an apparently empty profile. Back up SQLite consistently, including WAL state; preserve chat/project IDs, model snapshots, approvals, plans and uncertain operations. Never publish or log configuration secrets.
- Implement durable migration receipts, interrupted-migration recovery and profile/backend single-instance ownership. Keep imported projects in place. Define launch/readiness/shutdown interfaces and authenticate backend identity instead of trusting a process on an expected port.
- Acceptance: changed working directory, upgrade/restart, explicit overrides, ambiguous/missing sources, migration failure/retry, open/WAL database, second-instance and port collision tests. No automatic replay of uncertain actions.
- Own scoped configuration/bootstrap/store/lifecycle code, migration helpers/tests and architecture/API/setup docs. No Electron UI, sandbox or elevated helper installation yet.

### M17 — Sandboxed Linux tools and project-local dependencies

Delivered on GitHub main `94ad705` on 2026-10-13: candidate `73f0328`, merge `ab165b6`. Independent Windows checks passed (524 tests, 32 platform/optional skips), exact main Linux CI passed [run 38502382308](https://github.com/Deathstar1342/react-harness/actions/runs/38502382308). M18 dependency released. Detailed evidence and restrictions: [M17 report](reports/milestone-17.md).

- Implement a Bubblewrap-backed execution adapter around persistent shells, Python and tests. Keep existing ToolService contracts compatible where possible. All agent-controlled command descendants stay inside the boundary; a failed/unavailable sandbox must fail closed, never silently run a host shell.
- Explicitly expose the selected project writable, private per-project dependency/cache/home/temp storage, and the minimum read-only toolchain files. Exclude application state, provider keys, personal home, host-control sockets and other projects. Handle protected credential paths and project symlinks without exposing their external targets. Verify WSL interop and Windows paths cannot bypass the boundary.
- Define process/IPC/network policy, including package downloads. Enabling downloads must not expose the privileged helper, local backend, host services or metadata endpoints. Keep backend/provider access outside the agent sandbox. Do not claim domain controls from plain network namespace creation alone.
- Use project-local Python environments, JavaScript dependencies and private caches. Preserve PTY cwd/session behavior, cancellation, output, file watching, workspace hashes and editor safeguards. Mount selected projects directly; no SSHFS or managed-copy import change. Isolated storage survives shell restarts and can be reset explicitly without deleting project source.
- Acceptance: real Linux/WSL adversarial tests attempt outside reads/writes, symlink escapes, child-process escapes, helper/backend access, host-process access and Windows interop; verify allowed dependency installs/builds/tests and PTY recovery. Test unsupported user-namespace configuration and package-install hooks. Resource limits and writable-project risks must be documented honestly.
- Own execution/filesystem-policy adapters and focused runtime/tool wiring/tests/docs. This is a Linux boundary; portable mocks alone cannot satisfy acceptance. No host package installation or privileged service yet.

### M18 — Narrow privileged package-install helper

Delivered on GitHub main `78c979b` after independent review of candidate `af0fda3`. Both exact main workflows passed: [Validate](https://github.com/Deathstar1342/react-harness/actions/runs/38507566983) and [privileged helper](https://github.com/Deathstar1342/react-harness/actions/runs/38507566989). Independent coordinator checks passed (527 portable tests, 33 platform/optional skips, 20 Python tests, typecheck/build). M19 dependency is released. Evidence and platform limits are in [M18 report](reports/milestone-18.md).

- Implement a separately installed Linux helper/service for the selected execution environment; start with `apt` on Ubuntu/Debian. Define a versioned package-manager adapter so unsupported managers are rejected explicitly. Keep the application/backend non-root.
- Provide explicit setup/uninstall/repair entrypoints for M20. A trusted OS authentication flow installs root-owned helper code/configuration and registers the authorized local application principal. No administrator passwords in model context, browser state, ordinary logs or IPC payloads. No broad passwordless sudo, arbitrary root shell, user-writable privileged module/runtime, or agent access to helper sockets/capabilities.
- Accept structured target/package/version requests only, never a model-supplied executable, shell command, package path, package-manager option, configuration file or environment. Use trusted fixed binaries, sanitized environment/working directory and authenticated narrow IPC. Preview resolved packages/versions/dependencies, configured repository provenance and system impact. Unknown/unbounded impact fails closed.
- Bind execution to an exact, expiring, single-use authorization and preview digest; serialize package operations, verify target identity and revalidate before installation. Reject stale approvals, substitutions, duplicate/replayed requests and implicit removals/downgrades. Repository additions, remote install scripts and whole-system upgrades are outside this install action.
- Track prepared/authorized/running/succeeded/failed/uncertain outcomes durably across application/helper restarts. Never replay an uncertain root operation. Reconcile actual package state, preserve logs with bounded redaction, and require explicit recovery for package-manager lock/partial configuration issues. Shared-environment installations coordinate across projects.
- Acceptance: forged/expired/reused authorization, argument/config injection, hostile cwd/environment, writable helper tampering, unauthorized IPC callers, stale package plans and concurrent locks. Perform actual privileged install/restart/removal tests only in disposable authorized Linux VM/CI environments, never silently provision the developer's workstation. Successful mocks are insufficient.
- Own new helper/bootstrap protocol, first package adapter, audit persistence and dedicated tests/docs; no AI decisions or Settings UX yet. Helper installation grants real system-change authority, and approved package maintainer scripts may run as root; it is not a guarantee that a trusted-repository package is harmless.

### M19 — System-install policy, Settings and independent AI review

Delivered on GitHub main `7bbc35f` after independent review of `39a0d44`. Both exact main workflows passed: [Validate](https://github.com/Deathstar1342/react-harness/actions/runs/38511291030) and [privileged helper](https://github.com/Deathstar1342/react-harness/actions/runs/38511290882). Coordinator independently verified policy/recovery safeguards and final terminal-approval display correction. M20 dependency released. [M19 report](reports/milestone-19.md) separates portable, synthetic browser, real-helper and device/live-provider evidence.

- Add **System installs** immediately beneath workspace approvals in Settings: **Ask every time**, **Auto-approve**, **AI review**. Default to Ask; changing workspace policy does not change system policy. Make the selected execution environment and scope visible. Policy belongs to the configured application profile/target, not a model instruction or project file.
- Add a minimal advisor-style structured request action for missing system dependencies; never interpret arbitrary `sudo` shell text as helper authorization. The backend resolves the concrete preview and applies deterministic eligibility rules before any human/AI decision. Planning mode cannot install packages under any policy.
- Ask mode uses the existing approval experience with target, packages/dependencies, impact and reason. Auto-approve authorizes only requests supported by the helper policy. AI review makes a fresh bounded STARK Chat Completions call with curated structured evidence and fixed review policy; no tools, secrets, full transcript or install capability given to the reviewer. Treat all supplied justifications/metadata as untrusted data.
- Validate only approve/reject/ask outcomes with a short reason; malformed/refused/unavailable/timed-out review falls back to a pending human question. Rejection goes back to the architect with a bounded reason. Add a selectable install-reviewer model (default critic model when this feature is initialized); snapshot model/policy/preview per request. No provider transport changes or prompt rewrite.
- A policy/model/preview/target change or cancellation invalidates pending decisions. Raising autonomy must not silently release previously pending installs. Preserve scheduler limits, idempotency, restart recovery, test/terminal visibility and an on-demand install history showing actual outcome and approval source. Uncertain install outcomes are never rendered as success.
- Acceptance: all three policies, prompt injection, invalid reviewer JSON, policy changes during requests, cancellation/restart, duplicate decisions, plan-only restriction, package-plan changes, and no helper token/key in model/renderer/sandbox environments. Synthetic reviewer checks plus real helper integration; separate live-STARK acceptance remains explicit.
- Own settings and install UI/API/store/runtime/provider-review wiring, scoped shared contracts/tests/docs. Use M18 helper only; do not add alternate elevation paths. No Electron package yet.

### M20 — Electron application and guided first-run setup

Implementation reviewed, integrated and published on GitHub main `6f99a53` on 2026-10-14 from delivery `76c252a` / source `8d1fc93`; coordinator integration checks passed 640 Windows tests / 33 skips, typecheck, desktop build and real Windows Electron smoke. All required exact-main steps passed: [Validate](https://github.com/Deathstar1342/react-harness/actions/runs/38541494344), [Desktop Windows/Linux](https://github.com/Deathstar1342/react-harness/actions/runs/38541494145), [helper](https://github.com/Deathstar1342/react-harness/actions/runs/38541494103). User explicitly requested proceeding to installers after the installed Windows/WSL fixes; outstanding native picker, graphical authentication and desktop-close-during-install checks remain M21 release gates, not completed acceptance. See STATUS for successor dispatch; live STARK testing remains at work.

- Reuse the existing React UI in a hardened Electron shell with constrained preload/IPC, sender validation, context isolation, renderer sandboxing, no renderer Node access and controlled navigation/external links. Keep the compatible Node 24+ backend in its own packaged process; validate node:sqlite/node-pty compatibility rather than assuming Electron's Node ABI matches.
- Implement single-instance window/backend ownership, readiness identity, authenticated local transport/SSE, helpful startup errors, crash recovery and deliberate shutdown during running work. Restrict agent access to this transport. Preserve the ordinary browser mode without introducing an unauthenticated alternate privileged route.
- First-run setup selects/validates the supported Linux environment, sets up the stable profile and imports legacy state through M16, checks Bubblewrap/toolchains, and explicitly offers helper provisioning with OS authentication. Verify provisioned service identity/version and offer repair/removal. Declining or cancelling helper setup leaves system installs disabled; it must not disable normal safe app use or grant a host-shell fallback.
- Windows shell launches into an explicitly selected WSL2 distribution; never pick an unrelated service distribution. Native folder selection translates and validates project paths in that environment. Native Linux shell uses a compatible local backend. Show which environment system installs affect. Handle missing WSL, namespace restrictions, service-manager availability and restart requirements with an actionable setup state rather than an endless spinner.
- Preserve chat-first design, abysSUS branding, editable files, approvals, plan panel and direct imports. Do not add container workers or SSHFS.
- Acceptance: real Electron smoke checks on intended platforms, native picker/cancel, configuration/migration, helper auth allow/deny/cancel, restart, second instance, crash, malicious IPC/navigation, dirty editor, PTY, active install shutdown and changed launch directories. Keep browser-only checks distinct from installed desktop acceptance.
- Own `desktop/**` and packaging bootstrap scaffolding, native adapters and necessary transport/UI integration/tests/docs. M21 owns final distributable/release gates.

### M21 — Installers, upgrade/uninstall and end-to-end release

Implementation reviewed for integration on 2026-10-14 from handoff `17d15ef` / tested source `bf42091`; final release acceptance remains open. All candidate CI workflows and independent coordinator Windows/package checks passed. Exact-main validation follows publication; native/manual acceptance remains explicitly required. See [coordinator review](reports/milestone-21-coordinator.md) and STATUS for current evidence. No milestone closeout or release publication is implied.

- Produce reproducible Windows x64 installer and Linux x64 `.deb` packages with bundled UI/backend runtime and the appropriate native modules/helper assets. Freeze exact supported Windows/WSL/distribution versions from evidence; unsupported targets get explicit messaging. No developer Node/npm required for ordinary launch; document remaining WSL/system prerequisites and work-network/offline bootstrap requirements.
- Pin and verify downloaded/bootstrap components, document license/redistribution obligations, and establish a signing/release policy. Never claim artifacts are signed without actual verified signatures. Missing external signing credentials can be a labelled release limitation or genuine distribution blocker depending on workplace requirements, not an excuse to skip independently testable work.
- Test upgrades, interrupted updates/setup and uninstall; preserve chats, settings, projects and dependency state by default. Remove helper authority only through the trusted uninstall path. No silently forced update during active work, credential bundle or automatic OS package removal. First release can use explicit manual application updates; an unattended updater is not required.
- Run integrated acceptance from fresh machines/disposable VMs: install → configure → import/create → plan → build → project-local dependency → each system-install policy → editor conflict → restart → upgrade → uninstall. Test malicious package requests, sandbox denial and uncertain elevated-operation recovery. Verify builds can run without access to app secrets or other projects.
- Publish only reviewed release artifacts/checksums and setup/support docs to GitHub; never include runtime data. Report exact commits/artifacts/CI, installed-device evidence and unresolved live-provider/work-network limits. Pause check-ins when delivered; do not start M22.
- Own release/build workflows, installer assets, end-to-end tests and acceptance/setup/release documentation. Coordinator owns final publication and milestone closeout.

Each child must run applicable typecheck, full tests and build plus its meaningful Linux/WSL/privileged/desktop checks. New dependencies or security-contract changes need a concrete coordinator review. These milestones define future implementation work; no claim of a current sandbox, privileged helper or Electron installer is made.

## Approved M12–M15 sequence (2026-10-13)

Delivery: all four milestones are reviewed, integrated and published on GitHub main with exact Linux CI passing. M15 integration `141d8f4` passed run `38375035736`; detailed evidence and acceptance limits are in STATUS and each milestone report. A separately approved small visible-name/logo follow-up to **abysSUS** follows M15; it is not an additional numbered milestone. Containerization and executable packaging remain deferred.

The user reports that `init_test` works with STARK at work and authorizes bringing it into `main` (this repository has no `master`). Preserve the advisor-style model wording and ordinary Chat Completions compatibility. Local main was fast-forwarded to `b12bb53`; publish the integration after M12 repairs and independent validation. The older delivery records below remain historical.

Use the previous workflow: sequential dedicated chats named exactly `Milestone 12`, `Milestone 13`, `Milestone 14`, and `Milestone 15`, each in an isolated `codex/` branch/worktree. Children commit and report to coordinator `01a0dc0a-8866-7182-acd2-da997779962d`; the user explicitly authorizes messaging between these chats, routine coordinator decisions, commits and pushes. Children do not merge main or begin successor work. The coordinator independently reviews, requests corrections, validates and pushes integration before dispatching the successor. Check the active chat every 15 minutes, stay quiet when unchanged, pause immediately for a genuine user-assistance blocker, and pause after M15 delivery. Work-only live STARK access is a known acceptance limit, not an implementation blocker.

### M12 — Error presentation and focused runtime corrections

- Preserve the working advisor protocol, latest-user-message guidance and bounded format retries. Avoid wholesale prompt rewrites or telling models they directly execute actions.
- Historical errors belong to their originating turn/action. Persistent composer notices represent unresolved current blockers only, with appropriate dismissal/resolution. Preserve approvals and uncertainty rather than hiding them.
- Investigate false tool-failure labels with a bounded evidence-first pass; fix reproducible straightforward causes, record unresolved cases without speculative rewrites. Distinguish command exit success from report/format/UI failures.
- Correct the checkpoint message that declares a preceding failed action successful; critic verdicts must not rewrite observed execution evidence.
- Tighten JSON recovery at the parser boundary: accept a complete validated object or an unambiguous whole-message fenced object; never extract an executable nested action from incomplete outer JSON, arrays, examples or arbitrary surrounding prose. Formatting retries may request a complete recommendation. Preserve schema and policy checks and do not log raw rejected model content unconditionally.
- Reconcile the three known baseline test failures with intended behavior: one obsolete protocol-wording assertion and two connection diagnostic retry-count assertions. Add meaningful regressions for the new parsing/error behavior, not merely weaker assertions.
- Own `server/protocol.ts`, `server/runtime.ts`, error-related `client/**`, focused tests (including settings/protocol regression updates), scoped API/type changes only if necessary, and `docs/reports/milestone-12.md`. No project deletion, provider settings or plan workflow implementation yet.

### M13 — Chat and project removal

- Subtle accessible sidebar overflow menus, visible on hover/focus/selection; preserve the dark, flat design and navigation/editor guards.
- Delete a chat and its dependent app records. Project confirmation offers **Remove from app only**, **Delete project and files**, and Cancel. App-only removal preserves every project file. File deletion shows the exact canonical directory and requires an additional explicit confirmation.
- Destructive operations are server-validated and serialized against active work, pending operations and dirty editor leases; never delete a running workspace. Reject unsafe roots, the app/config/data directories, overlapping registered projects and link/path substitution hazards. Do not traverse links into other directories. Revalidate the exact confirmed target immediately before the operation.
- Deletion applies only to the selected registered project, not its workspace parent. Imported projects may be deleted only with the same explicit exact-path confirmation. Partial failures must remain visible/recoverable; never report deletion as successful when files or records could not be removed.
- Own scoped `client/**`, project/chat API/store/runtime lifecycle and tool/watch/session cleanup paths, shared contracts, targeted tests, relevant architecture/API/setup docs, and `docs/reports/milestone-13.md`. Do not broaden into arbitrary filesystem management.

### M14 — Provider settings and per-chat model assignments

- Settings selects architect/coder/critic defaults using `/models`, with manual ID entry when discovery is incomplete. Preserve connection-test behavior and allow a masked key to be replaced/cleared. Keep transport/JSON toggles out of this feature.
- Persist defaults and the API key in the backend `.env`, preserving unrelated entries and using validated, atomic updates; prevent newline/config injection, unsafe file targets and accidental exposure. Never echo the stored key in API responses, logs, browser persistence, probes or child shell environments. The explicitly entered key necessarily travels in the protected settings request only.
- Snapshot model IDs into durable chat records at creation. Changing defaults affects **new chats only**. Backfill existing chats with their pre-change effective assignments before accepting new defaults; use their saved models throughout runtime, critic and compaction calls and across restarts. The API key remains shared configuration, not a per-chat secret snapshot.
- Configure the server safely without interrupting an in-flight request or mixing provider state. Document whether credential replacement takes effect on the next request; never silently migrate old chat model IDs.
- Own scoped settings UI/API/config/provider/context/runtime/store wiring, shared contracts, targeted tests, architecture/API/setup docs and `docs/reports/milestone-14.md`. No native provider tools/Responses API or new secret-management dependency without coordinator review.

### M15 — Planning to execution and accessible progress

- Add **Start building** to explicitly transition a planning chat into execution using its existing plan/history. Support clear user intent such as “go ahead” through a validated mode-transition recommendation or equivalent coordinator-reviewed mechanism; ambiguous prose cannot override plan-only restrictions. Model-facing language must remain recommendation/advisor oriented.
- Persist mode changes, enforce approvals and fresh versions, handle active requests/steering/restart and make repeated clicks idempotent. A generated plan alone never authorizes execution.
- Move the plan from the beginning of the transcript into an on-demand collapsible panel reachable from a stable chat-header Plan control. Show compact phase/step progress without persistent large chrome or requiring a scroll to the top. Preserve editor state and narrow-screen access.
- Associate delegated work with stable plan step identities and update progress from actual start/completion/review outcomes. A successful tool call alone is not a completed step. Preserve blockers, failures, manual plan revisions and critic acceptance; the architect can still revise scope. Avoid fabricated completion for legacy/unassociated work.
- Own scoped plan UI/API/runtime/store/shared-contract changes, targeted tests, architecture/API/setup docs and `docs/reports/milestone-15.md`. Keep prompt changes minimal and explain each in the handoff.

All deliveries require commit SHA, changed interfaces, typecheck, full tests, build and targeted evidence with explicit Windows/Linux/browser/STARK limitations. Coordinator owns `docs/STATUS.md` and milestone dispatch records. Additive contracts within each scope are preapproved subject to independent review; ask the coordinator about broader changes. Do not publish credentials, local databases, user project files or generated artifacts.

| ID | Milestone | Acceptance |
| --- | --- | --- |
| M0 | Foundation and coordination | Reproducible Node/React scaffold, shared interfaces, CI, GitHub milestones, persistent coordination record |
| M1 | STARK provider and JSON protocol | Model discovery, text streaming, complete validated actions, cancellation, bounded retries, mock-provider tests |
| M2 | Durable conversations and orchestration | SQLite projects/chats/events, architect delegation, approval/resume, restart recovery, steering |
| M3 | Workspace tools and persistent shells | Confined file tools, hashes and stale-write checks, diffs, editor leases, PTY state, Git, structured test artifacts |
| M4 | Chat workspace interface | Project/chat navigation, real API chat, plans, editable syntax-highlighted files, diffs, approvals, test results |
| M5 | Reviews and context management | Critic checkpoints, bounded repairs, summaries with durable state retained, configurable budgets |
| M6 | Integrated release validation | Reviewed integration, meaningful automated/browser/Linux tests, setup docs, honest remaining live-provider acceptance |
| M7 | Seamless dark workspace | Codex-inspired dark chat interface with less button chrome, folder explorer for import, automatic new-project workspace, and Settings to choose its drive/folder |
| M8 | Settings and focused chat | Test connection; approval level in Settings with distinct current-chat/default scopes; persistent debug toggle; internal agent chatter hidden by default while errors and approvals remain visible |
| M9 | Project instructions | Root AGENTS.md applies to all roles, refreshes safely after changes, survives compaction/restart, and cannot override runtime controls |
| M10 | Changes review and conservative undo | Project-wide Git changes and separate agent-write history; file diffs; version/lease-protected per-write undo with durable uncertain-outcome handling |
| M11 | On-demand terminal | Terminal button beside Files; collapsible read-only command/output view with running/completed/exit evidence; closed by default; tests remain accessible |

Milestones may develop concurrently after interfaces are established. Integration remains coordinator-owned. Implement the single-coder loop before attempting parallel coder execution.

## Approved follow-up workflow (2026-09-27)

Delivery record (2026-09-28): M8–M11 are reviewed, integrated and passed exact Linux CI. Their scoped GitHub issues/milestones are closed and the existing heartbeat is paused. No successor milestone is scheduled. See STATUS and acceptance for commit/run evidence and the still-open browser/live-STARK acceptance gates. The workflow below records the approved process used for this sequence.

Deliver M8, M9, M10, and M11 **sequentially**, each in a dedicated chat named exactly `Milestone x` and an isolated `codex/` branch/worktree from reviewed main. The coordinator reviews code and evidence, requests fixes, runs integration checks, and pushes main before dispatching the next milestone. The user authorizes the coordinator to decide routine design, interface, and implementation choices; escalate only decisions that truly need the user's information or approval. Child chats must send routine questions to the coordinator rather than stall awaiting the user.

The existing 15-minute heartbeat monitors the active chat, helps with stalls, reviews deliveries, and advances the sequence. Stay quiet when unchanged. Pause immediately when progress truly requires user assistance; pause once M8–M11 are delivered. Live STARK access at work is an explicitly deferred acceptance gate, not a reason to stall independent implementation or repeatedly request credentials.

The interrupted coordinator draft is saved at `8a87bb2` on `codex/feature-preparation-20260927`. It is **not integrated** and must not be cherry-picked wholesale. [Preparation report](reports/feature-preparation-2026-09-27.md) maps its files to milestones and records unvalidated behavior.

### M8 scope and acceptance

- Add Test connection in Settings: catalog availability, exact configured model IDs, bounded reply-format probes using normal transport and scheduler accounting. Never execute returned actions or display raw JSON/keys. Handle cancellation, timeouts, concurrent checks, refusals, malformed replies, and sanitized failure reports.
- Move approval selection from composer to Settings. Explicitly label current-chat mode separately from a persisted default for future chats. Changing one must not silently change unrelated chats or execute pending proposals.
- Persist debug preference. Default chat shows user/architect conversation and actionable errors/approvals, with internal coder/critic/tool detail available only when debug is on. Test outcomes remain accessible; hiding diagnostics must not hide failures.
- No streaming toggle or JSON-format setting. Preserve editor resize/expand behavior, dirty leases, project navigation, and existing settings.
- Child owns `client/**`, `server/app.ts`, new `server/diagnostics.ts` and settings helper if needed, `shared/types.ts`, scoped tests, `docs/api-contract.md`, and `docs/reports/milestone-8.md`. Coordinator preauthorizes additive settings/diagnostics contracts fitting this scope; document exact choices. Request scope expansion before editing other runtime/security modules or dependencies.

### M9 scope and acceptance

- Fresh bounded root AGENTS.md guidance for every role; include outside compacted history, follow explicit user requests, preserve enforced permissions, and detect changed guidance before relying on old proposals.
- Cover absent/oversize/linked files, edits during requests/approval waits, compaction, and restart with meaningful tests. Nested instruction discovery is out of scope for this iteration.
- Child owns `server/project-instructions.ts`, `server/runtime.ts`, relevant context integration only as needed, targeted tests, an example instructions document, API/usage documentation, and its report.

### M10 scope and acceptance

- Show current Git modifications including pre-existing/manual changes, separately labelled from recorded agent edits. Browse files and readable diffs without exposing protected credential paths.
- Durable before/after history for confirmed agent file writes, and explicit preview before undoing one recorded write. Restore modified content or remove a newly created file only when current version and editor leases permit; preserve later manual changes by refusing incompatible undo.
- Handle concurrent requests, stale previews, crashes, uncertain outcomes, deleted/renamed paths, and pre-existing dirty Git work. No destructive Git reset and no automatic replay of uncertain undo. Arbitrary shell effects have review, not automatic undo.
- Child owns changes/store/file-tool/runtime integration and shared contracts, related UI, targeted tests, API/usage docs, and its report; coordinator reviews all mutation boundaries.

### M11 scope and acceptance

- Terminal button beside Files opens an on-demand, initially closed read-only command/output panel. Show real command lifecycle and exit evidence, associate output correctly, and distinguish interrupted/uncertain sessions.
- Preserve test report access and error visibility without exposing internal critic chatter in ordinary chat. Opening/closing the panel never runs a command or resets an agent shell.
- No interactive command entry in this milestone. Preserve Linux PTY behavior and honestly report Windows/browser/live-provider limits.
- Child owns terminal UI and bounded event/schema additions if required, relevant tests, API/usage docs, and its report.

Every delivery includes commit SHA, changed interfaces, typecheck/full tests/build, meaningful focused tests, and explicit browser/Linux/provider limitations. Coordinator-owned STATUS, milestone sequencing, and integration must not be overwritten by child chats.

## Release scope

The first release must support all requested core user flows with one coder. Parallel coders and isolated integration are an extension only after that baseline is verified. Do not imply parallel execution is implemented just because the architecture permits it.

## Public tracker

Milestones and their delivery issues are tracked in the repository's GitHub tracker. Close them only when the stated acceptance is actually met; record deferred and environment-dependent checks explicitly.
