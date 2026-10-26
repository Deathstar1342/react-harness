# Milestone 35 — isolated live project preview

Status: child implementation and validation complete, 2026-10-26. Ready for coordinator independent acceptance and integration. This final handoff changes only this report; implementation/tests/API/workflows remain the tested source below. Main integration, successor work, M21 and release remain coordinator/user controlled.

## Frozen identity and scope

- Branch: `codex/milestone-35`.
- Kickoff/base: `d1d0a392378fcf77fc16bf7b8e28b09a17bb7087`.
- Tested implementation: `599e9e0579f1314a9ecbc190a8e65f5e741a2b1b`; tree `f83712688e945409c445ef0be53e177eba84dba8`.
- Physical source: `D:/CodexData/.codex/worktrees/milestone-35-donly/REACT harness`.
- External receipts: sibling `m35-validation/`; final local stages `frozen-clean-*`, summary `frozen-clean-summary.json`; final CI archives/metadata/audits `ci-599e9e0/`.

The on-demand Preview panel opens a project's already authorized owned development server, renders React modules/root-relative CSS/assets and supports interaction plus explicit Reload. Close view leaves the server running. Stop server uses the existing exact owned-process cancellation/drain; stopping does not roll back effects or clear uncertainty. No preview route starts/restarts commands, models, goals, installs or Docker resources. GET/manual Reload is the supported contract; POST/forms/WebSocket/HMR/SSE/service workers/downloads remain unavailable.

Only scoped implementation/glue/types/API/renderer tests/additive CI and this report changed. Coordinator STATUS/milestones/automation, main, M21 and prior worktrees/unreviewed files remain preserved. Early proposals/reviews remain in branch history.

## Authority, private state and transport

Optional strict `start_process.args.previewPort` is an integer1024–65535 excluding worker egress3128. The original native action/approval/archive contains it. No arbitrary host/URL/socket/container/command discovery or new execution authority is accepted. Existing task/frame/call/generation/mode/approval/guidance/skills/root/version/lease/reservation checks remain authoritative. A successful existing beforeCommand COMMIT pins the private prepared WorkerBinding and root identity; live in-memory ownership must still match every resource/page. Backend recovery marks old nonterminal jobs uncertain and adopts/replays no server or view. Public process/preview DTOs omit worker binding, broker capability and private target identity.

Preview-only SQL checks source blob sizes before JSON parsing, rejects duplicate keys at every original object depth and checks primary/foreign/embedded ID correlations plus registry root/data.path agreement. Process record<=256KiB, run<=2MiB, project/chat<=16KiB, each projection<=16KiB, up to64 records/256KiB aggregate. Observer/final-COMMIT failures and shared native poison still refuse access; read/close exceptions never renew effect authority. Checkpoint/editor/export/reset/removal/install/goal blockers continue to use the existing running/uncertain writer reservation.

The fixed image-owned, source-attested Python GET helper connects only to literal worker127.0.0.1 and its approved port. It strips all caller credentials/headers and returns only allowlisted status/type/bytes. It rejects unsafe/encoded/protected targets, redirects/upgrades, ambiguous/duplicate/oversized headers, compression/framing conflicts/trailers, unsupported media, truncated/oversized bodies and timeout. The worker retains its existing namespace/network/mount/secret restrictions and receives neither Docker control nor controller state.

Authenticated broker `preview_open/read/close` verifies exact claim/session/context/project/root/image/resources. Read serves one bounded retained observation; it launches/retries no network operation. Helper input4KiB/output6MiB/stderr4KiB, headers16KiB/body4MiB, fetch15s/watchdog17s, four global/two context fetches, eight buffers/32MiB,32KiB monotonic pages/20s buffer TTL preserve the256KiB worker wire bound. Controller resource lifetime25s plus2s best-effort close; explicit abort closes the exact wire, never sends a late queued connect and discards stale publication. Lost accepted replies remain failures/uncertainty without retry.

## Native and browser isolation

Native main creates a random secure `abyssus-preview` origin in a unique ephemeral sandboxed WebContentsView session. Before project bytes: no preload/Node/worker Node/webview/insecure content/devtools; contextIsolation/webSecurity; exact contents/frame/origin firewall; fixed nonforwarding SOCKS sink with loopback bypass removed; WebRTC non-proxied UDP denied; permissions/downloads/popups/navigation/redirects denied; restrictive fixed CSP. App bearer remains in trusted main and only bounded media crosses to the view. Sender-checked IPC accepts current IDs and a bounded rectangle, never a caller URL. Guards remain until actual contents/network destruction, then storage/cache/sink drain. Backend/project/document changes, close, crash and expiry revoke it.

Browser support is conditional on actual runtime proof. Only trusted same-public-port source binding3000 or the explicitly loopback-bound embedding path is eligible. Native random Docker mapping remains unsupported as a browser listener; native uses its isolated view. No new host mapping/hosts/DNS/settings change is introduced. First onRequest routing exclusively diverts canonical random192-bit `.localhost` hosts before app auth/static/SPA hooks; all paths stay in the probe/worker boundary. Unknown/stale/malformed hosts fail without app fallback. App cookies/authorization never enter this host or worker fetch.

A paired current browser document must complete fixed trusted positive/protected/positive frames before any project byte. Actual HTTP/image/rejected-WebSocket/redirect/navigation sentinel counts and two-peer opened/data-delivered controls must succeed outside policy, fail under policy and succeed again. Parent checks exact frame source, opaque origin, nonce/document/probe/stage/order/schema and destroys each frame before advance. UA/property/header recognition alone grants nothing. A distinct project host has a single-use initial iframe ticket consumed synchronously before fetch; generic HTML subresources, absent/forged destination, replay and top navigation fail. No HTML/JS rewriting is used.

Opaque project frames use allow-scripts only and fixed CSP/Connection-Allowlist. At most eight combined probe/view records;120s original proof/tombstone deadline,25s stages,16KiB trusted documents/2KiB result messages,64 requests including sentinel/upgrades,256KiB request bytes/128KiB response allowance and saturating counters are enforced. Terminal admission refuses a ninth record. View expiry cannot exceed the original retained proof; remaining lifetime caps resource aborts and post-await pruning discards late bytes. Late protected hits revoke linked views. Page departure/BFcache/close/reload/restart revoke without adoption; explicit Reload repeats proof.

## Frozen local evidence

Every final stage ran `node scripts/validate-m35.mjs TASK FRESH-STAGE`. Before mkdir/children, it checks output ancestry and physical D source/common Git/dependency/temp/cache/build/receipt roots, matching source/dependency lock hashes and clean source identity. The development-only dependency junction uses an existing matching D lockfile; it proves no deployable archive. Original C checkout and unrelated worktrees were not synchronized or cleaned.

| Check | Exact599e9e0 result |
| --- | --- |
| Full Windows suite |1104 passed,47 skipped;83 passing/3 skipped files;137.93s |
| Typechecks | Both application and desktop TypeScript configurations pass |
| Production builds | Vite app, desktop/server payload and bundled real React fixture pass; existing chunk-size warnings retained |
| Portable Python broker matrix |65 tests,19 Linux-only skips; remaining tests pass |
| Actual Windows native view | Production panel/IPC/NativePreview, real SQLite; positive HTTP/TCP/UDP then protected0/0/0, React Count1, bridge/token/provider denial, sink failure, reload/close/stop/no replay pass |
| Actual Windows browser | Chrome155.0.8059.85 three-stage proof/React/private0/0/0/ticket/HTML/POST/lifecycle pass; pageErrors=[] |
| Actual unsupported browser | Pinned Electron42.11.13/Chromium148.0.7778.280 refuses before any worker read and cannot use a consumed active URL |
| Rich projection/response budget |64 records,1,560,499-byte run,18,596-byte catalog,4MiB response/128 pages and384 total pages; list 18.86ms, largest response 429.28ms |

Standalone renderer fixtures use doubled worker transport and real SQLite. The rich-budget timings are controlled local observations, not a Docker/native latency guarantee. No workstation agent project command, Docker/WSL/helper/global provisioning or live provider call occurred.

## Exact-source CI

All original six applicable workflows, ten jobs and every applicable step were independently fetched and audited on `599e9e0579f1314a9ecbc190a8e65f5e741a2b1b`. Only declared platform/cross-build/failure-diagnostic skips occurred. Raw run/job/step metadata is `ci-599e9e0/jobs.json`; checked receipt is `steps-audit.json`.

| Workflow | Run | Jobs |
| --- | --- | --- |
| Privileged helper validation | [40355578350](https://github.com/Deathstar1342/react-harness/actions/runs/40355578350) | helper:121687012975 |
| Private desktop support runtime | [40355578527](https://github.com/Deathstar1342/react-harness/actions/runs/40355578527) | runtime (ubuntu-24.04):121687011980, runtime (windows-latest):121687012289 |
| Validate | [40355578405](https://github.com/Deathstar1342/react-harness/actions/runs/40355578405) | verify:121687011768 |
| Desktop validation | [40355578674](https://github.com/Deathstar1342/react-harness/actions/runs/40355578674) | electron (ubuntu-24.04):121687013269, electron (windows-latest):121687013492 |
| Container foundation | [40355578943](https://github.com/Deathstar1342/react-harness/actions/runs/40355578943) | linux-container:121687013497 |
| Guided container source desktop | [40355578399](https://github.com/Deathstar1342/react-harness/actions/runs/40355578399) | linux-source (ubuntu-24.04):121687010990, linux-source (ubuntu-22.04):121687011547, windows-payload:121690953379 |

The original Container stages remain intact. Added real worker preview coverage proves attested helper/interpreter, credential-free exact GET/assets/multipage bounds, no redirect target request, finite malicious reply deadline, actual natural exit, distinct explicit restart, old-claim rejection, exact namespace removal/no late descendant writes, unrelated workload survival and restart/no adoption. Cancellation records **uncertain**, preserving its actual outcome rather than fabricating success.

The connected disposable Linux path uses actual production controller/Store/Runtime/WorkspaceTools/Previews/WorkerClient authenticated Unix wire, trusted broker and owned Node worker, then actual Chrome155.0.8059.39. It renders React Count1, verifies scrubbed worker environment and private DTOs, blocks checkpoint capture409 while the writer runs, revokes old hosts, reopens with fresh proof and stops the exact worker. Running starts1/providerCalls0/errors[]; same persistent controller recovery starts0/providerCalls0 and no automatic view/command/provider/probe or adoption. Its CI-only readonly-mounted fixture authorizes one synthetic native call; it is not a shipped entrypoint. Connected source-bound PNG and JSON receipts were inspected.

Connected immutable controller/worker IDs are recorded in `preview-connected/connected.json`. Exported source payloads have their own immutable image IDs in provenance; each audit checks its own exact binding. Actual Windows Docker/device execution is a separate limit below.

## Fresh archive audit

All nine final archives were copied to physical D and matched against published size/SHA-256, exact source metadata, canonical unique/case-folded member names, link refusal and CRC. Semantic checks require zero page errors, actual native positive/protected counters, unsupported-browser no-worker-read, connected render/recovery/source identity and expected PNGs. Metadata/audit files: `ci-599e9e0/artifacts.json` and `audit.json`. The external read-only auditors execute no payload.

| Artifact | ID | SHA-256 |
| --- | --- | --- |
| desktop-evidence-ubuntu-24.04 | 12665901837 | `21bd98c4952d1197de5cb1afe82e76ee04b54d01ee81743dc9867e46b9eb927e` |
| desktop-evidence-windows-latest | 12665593493 | `9b31e9c40525bdc65a95c19dd2dfe0fbd21240fb0cc0e688a1eb5c4998864df4` |
| source-evidence-windows | 12665937354 | `e0b4db8ec8781ecd664bacc60b154208ead909f0d1103521364c9263660c2fea` |
| source-windows | 12665737564 | `78600b9791409332af95ec0e968844fd50a6133c1a7b69e3b6e6387b076113a1` |
| source-evidence-ubuntu-24.04 | 12665662657 | `0a7b85ef29183afbad46f12faa9441de955bb8e350a2a935a7eb882d4ad5845e` |
| source-evidence-ubuntu-22.04 | 12665249558 | `c89a30690eb323d4fa5c8072792f2d6aed213d867fb6a53ce12b9e203ca0af4f` |
| container-foundation | 12665529482 | `027eb969a9fa2c396a01c2e738179e1dd81a3d3ddfa26e12ede63c4c6a345ccc` |
| private-runtime-windows-latest | 12664938732 | `0f08ff2e541470eae4b270a7e371d3969b43b4d8f5bb95242b1cbdb9404e71bc` |
| private-runtime-ubuntu-24.04 | 12664774801 | `a4612433b2e5ad62a8f3f026254107c9cf85821c9f2060ef25919c2256aeeda4` |

Windows source ZIP:205,331,802 compressed bytes,10,396 members/587,644,254 expanded bytes. All10,395 inner manifest hashes and exact member set passed, including new preview modules, exact committed helper bytes, source/platform/provenance/image agreement. Committed helper bytes were used for comparison because Windows checkout line endings differ. This is an independent child complete hash audit; target Windows payload execution also passed its original CI job.

## Preserved failures and corrections

- Header-only policy failed in pinned Chromium148 with a controlled private hit; native uses its tested session firewall/proxy/WebRTC protections. Missing UDP positives, external-build dependency fixture failure and earlier mojibake screenshots remain failed evidence; fresh final PNGs are clean.
- Initial private projections admitted tampered source IDs/duplicate fields/root-registry disagreement. Original coordinator reproductions are retained; strict original-JSON/key/root correlation now rejects them. Native observer/final-COMMIT/shared-poison fault tests pass.
- `pre-freeze-full-01` found real request-counter overshoot; saturation now enforces64 with a stricter regression. Terminal ninth-record admission and original-proof/view expiry mismatch were also corrected. Controlled-clock held-resource regression requires410/retired host421 and empty record maps after original expiry. The coordinator's original lifetime repro did not demonstrate a private network leak; it demonstrated lost linked-proof coverage.
- Early browser fixtures used a root-path cookie lookup instead of `/api`, a different disabled message, Node DNS for `.localhost`, then a hidden option instead of visible recovered status. Corrected tests use actual Chrome and exact retained API process IDs/status; original local/CI failures and ZIPs remain preserved.
- c2 jobs were green but its actual connected receipt contained two unhandled undefined.catch page errors. Strict stack reproduction located enforced-stage onicecandidate callbacks: Chromium can return undefined when addIceCandidate is denied. Promise.resolve settles that return safely; actual positive/protected/positive peer/counter requirements remain unchanged. Final standalone/connected tests and artifact audit require empty page-error arrays. `browser-error-repro-01`, c2 ZIP and `semantic-page-errors-failed.json` remain rejected clean-browser evidence.
- One early encoding-repair focused rerun incorrectly omitted the D temp prefix and used auto-cleaned C Temp. `routing-error-focused-rerun.json` is retained and excluded from acceptance; no manual C cleanup occurred. Every final stage verifies physical D before children. This report does not claim all earlier attempts were D-only.
- Coordinator retained a path-sensitive existing M34 checkpoint read-budget failure under a longer fixture temp path, then passed unchanged threshold/source with an existing shorter physical D temp. No checkpoint implementation/threshold was changed for this milestone.

## Remaining limits and handoff boundary

Local renderer tests, disposable Linux connected containers, Windows/Linux CI desktop/support/source payload checks and installed/native-human/device/provider evidence are distinct. Windows Docker Desktop user-selected D/NTFS storage, installed-device/native-human review, clean-machine/customer package/signing/licensing and live-provider acceptance remain unverified here. Browser compatibility is proven per session and fails closed when unresolved. GET/manual Reload and finite capacities/deadlines are intentional limits.

M21 packaging and automatic Installer candidates are separate held work; no installer release, main merge, successor or provisioning is authorized by this child handoff. No user assistance blocker remains. The child commits/pushes this report only, leaves the assigned worktree clean and stops; coordinator owns independent acceptance/integration/exact-main checks.
