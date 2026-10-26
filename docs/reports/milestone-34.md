# Milestone 34 — Task file checkpoints

Status: complete child handoff, awaiting coordinator integration. Product and fixture source is frozen at `bb59b51f6b4ea0b4e01303efb292380c66f771de`, tree `7a7dd6f6fc1242b415c6cdb0c831ba8fcd9bc965`. This final handoff changes this report only. Assigned branch: `codex/milestone-34`; kickoff `8b1010010ba931668e064704c8a1f295292d9b5f`; reviewed M33 foundation `371601602b31fdebe7533f5d09cb8a6103ab70e4`. Coordinator owns review, main integration and any later dispatch. No main merge, M35, M21 resumption or release was performed by this child.

## Delivered behavior

A project checkpoint panel lets a human capture a bounded complete set of eligible source-text files at an idle task boundary, inspect additions/removals/modifications, and explicitly restore the reviewed file set. Moves appear as remove/add. Opening/listing causes no capture, command, provider call or automatic restore. The normal recorded-file history identifies checkpoint restores as human actions and preserves existing agent-write attribution.

Captures bind project ID, canonical root identity, existing chat/human provenance, timestamp, policy and exact manifest digest. The service enumerates twice under exclusive admission and compares content, file identity and tree revision before publication. Registered managed-workspace membership is required in every execution mode, including portable fixtures; no arbitrary root argument exists. A capture is observation, never approval or verification authority.

The versioned `source-text-v1` policy excludes Git metadata, credentials, private/provider/runtime state, dependencies, build/cache/output directories and known binary assets. Excluded contents are never read. Safe AGENTS.md, `.abyssus/skills`, SVG/plain text and ordinary `bin/` scripts remain eligible. Unknown binary eligible files, unreadable/oversize source, incomplete traversal, unsafe components, case aliases, hard links, symlinks/junctions, special files and unstable observations reject the complete capture. This is a source-text checkpoint rather than a binary-asset backup.

Restore requires a fresh opaque one-use server preview token, the exact project revision and literal human confirmation. The token binds checkpoint digest, complete current tree identities/hashes/modes, exact changes, root identity, chat and expiry. Later edits or application revision changes refuse with a fresh-preview requirement. The UI provides full bounded diffs and an explicit confirmation checkbox. Topology collisions refuse before claiming. There is no model checkpoint tool, prose adapter, endpoint retry or generic uncertainty waiver.

## Interface and storage assumptions

Shared types and `docs/api-contract.md` describe these authenticated project routes:

| Route | Request / behavior |
| --- | --- |
| GET `/api/projects/:id/checkpoints` | Bounded metadata only |
| POST `/api/projects/:id/checkpoints` | Strict `{chatId,label?}` capture |
| POST `/api/projects/:id/checkpoints/:checkpointId/preview` | Strict `{chatId}`; selected manifest and exact diff |
| POST `/api/projects/:id/checkpoints/:checkpointId/restore` | Strict `{chatId,previewToken,revision,confirmation:"restore-files"}` |

All private data stays in the existing `state.sqlite`. Immutable `checkpoint:v1:<uuid>` bodies have separate `checkpoint-meta:v1:<uuid>` metadata. `checkpoint-restore:v1:<uuid>` lifecycle headers reference indexed `checkpoint_effects(restore_id,ordinal,change_id,data)` rows and normal `file_changes` before/after snapshots. The new table is created in an explicit observed transaction. No new private filesystem target, controller/worker mount or host capability is introduced.

SQL bounds returned rows, keys, per-record and aggregate bytes before duplicate-key-rejecting JSON parsing. Schemas validate exact key/ID/project/root/integrity/reference relationships. Ordinary listing/admission checks bounded headers and references without materializing source bodies. Selected preview, startup and final journal validation perform complete bounded validation. Each actual file effect reads its exact lifecycle header and indexed row, verifies the original human/token/revision/root/checkpoint binding and exact selected before/after digest. Unknown, malformed, orphaned, oversized or truncated evidence fails closed.

All checkpoint SQL uses the existing proxied Store database and observed synchronous private units. `nativeStateDatabase` retains `nativePrivatePath(store.filename)` for the exact existing main SQLite database and `nativePrivateCommit()` immediately before each transaction COMMIT. Capture/retention, intent/history, final completion/events, failure and startup use the existing Store transactions. Async filesystem operations retain existing native workspace authority. No checkpoint read or absent-path result grants recovery authority; private observer failure poisons the existing session.

## Bounds and retention

| Resource | Bound |
| --- | --- |
| Eligible source | 512 files; 256 KiB each; 8 MiB aggregate UTF-8 |
| Traversal | 10,000 visited entries; depth 32 |
| Manifest | 12 MiB serialized per immutable capture |
| Retained captures | 8 / 32 MiB per project; 64 / 64 MiB application-wide |
| Exact preview diffs | 200,000 bytes; refusal rather than eligible-set truncation |
| Preview tokens | Five minutes; one use; at most 100 and 32 MiB combined; lost on restart |
| Exclusion summary | At most 100 paths AND 16,000 serialized bytes; exact total count and omission indicator |
| Restore journals | 32 per project; 64 global; reconstructed journal at most 24 MiB |
| Indexed effect | At most 1,100,000 serialized bytes |
| Restore storage | 64 MiB total actual serialized headers/effects plus normal file-change summaries/snapshots |

Retention evicts oldest unreferenced captures transactionally only during explicit capture. Every retained restore journal, including done, live preview and runtime/history reference pins its checkpoint. Reference scans themselves are bounded and unknown coverage refuses. Journals/uncertainty never TTL-evict. Quota exhaustion refuses further work. Unresolved restore blocks project/chat deletion; ordinary removal cannot clear its barrier.

## Mutation safety and recovery

Capture and restore hold Runtime exclusive project admission, the existing project mutation reservation, confirmed worker cleanup/drain and dirty-editor gate. Active/awaiting-approval chats, executing native calls, pending decisions, dirty leases, active file operations, uncertain file/skill/install/process effects, active installs and export reservations refuse. Store, Runtime dispatch/resume/edit, WorkspaceTools, install reconciliation, skill writes/promotions, managed export/reset/removal and startup enforce the barrier. An idle-looking worker is insufficient without confirmed owned-context teardown.

Before the first filesystem effect, a durable transaction records the exact restore claim, selected effects and normal recording history, and consumes the preview. Extras are removed deepest first and selected content is restored through existing version/hash/lease/no-follow file operations. Git metadata/index, exclusions, empty directories, chat history and command/install/external effects are preserved. This provides a coherent reviewed target, not cross-file OS atomicity.

The final product correction revalidates the live canonical no-link root device/inode/birth identity at every actual effect. A checkpoint-only synchronous `effectGuard` is separate from the ordinary one-time history callback and repeats before access, each parent mkdir, temporary create/write, unlink/rename, permission inspection and chmod. Parent creation is component-by-component. Temporary files use exclusive creation and observed real descriptor identity; write, rename and cleanup require the same regular, single-link device/inode beneath the still-bound root. Lost ownership/root authority retains residue and uncertainty, never deletes a same-path replacement sentinel. Permission restoration separately verifies descriptor bytes and current confined target identity, then repeats the exact durable claim immediately before descriptor chmod.

After complete final-set validation, one observed transaction confirms journal/history and emits normal file-change evidence; Runtime invalidates workspace, goal, guidance and selected-skill freshness. Pre-claim COMMIT veto has no target effects. Any partial effect or lost final COMMIT retains claiming/uncertain evidence and blocks mutation across restart. Startup converts claiming to uncertainty without touching files, starting workers or provider calls. There is no automatic replay/rollback. If COMMIT completed, notification/reply failure preserves durable done. Reads, capture and apparent absence cannot clear uncertainty.

## Frozen-source validation

All generated receipts live outside source at `D:/CodexData/.codex/worktrees/milestone-34-donly/m34-validation/`; none are committed. Source/temp/cache/fixtures remained on physical D. No workstation Docker/WSL/helper/global provisioning occurred.

On exact frozen `bb59b51`:

- `npm run typecheck`: passes both TypeScript configurations (`frozen-bb59b51-typecheck.log`).
- `npm test`: **1083 passed / 47 skipped**, 81 passing and 3 skipped files, 129.96 seconds (`frozen-bb59b51-full-tests.log`). Windows skips remain Linux/PTY/Unix-mode limits.
- `npm run build`: passes (`frozen-bb59b51-build.log`); existing Monaco chunk warnings retained.
- Actual authenticated Chrome and actual sandboxed offscreen Electron: capture/list, add/delete/move/multifile preview, checkbox restore, history/chat preservation, private/binary exclusion, stale later edit HTTP409 and reload/no replay all pass, provider calls **0** (`frozen-bb59b51-chrome.log`, `frozen-bb59b51-electron.log`, source-bound JSON/stage/PNG files under `frozen-bb59b51-ui/`).
- Eight captures / 32 files read-budget fixture: list 10,275 returned SQL bytes; ordinary save 10,370; complete restore 4,175,087; largest returned string 254,860; 605 ms (`frozen-bb59b51-read-budget.json`). The asserted limits are under 4 MiB aggregate returned SQL strings, under 1 MiB each and under ten seconds. The aggregate is close to its bound and path-dependent; this measurement is not a universal latency promise.
- Disk/native observer regressions include capture COMMIT veto with no published capture/effects, final restore COMMIT veto with changed files plus retained claiming/recording and poisoned session, root substitution at intent/save entry/parent creation/between files/before chmod, same-name temp sentinel survival, stale claim/descriptor substitution, quota/integrity/retention, restart/no replay and durable-done notification/reply loss. Existing precise file/undo regressions also pass.

The coordinator independently checked out frozen `bb59b51`, passed the same 1083/47 suite, typecheck/build, actual Chrome/Electron and PNG review, and reproduced that the corrected root replacement remains untouched with durable uncertainty. Its independent review and full archive audit are committed in `docs/reports/milestone-34-coordinator.md` at coordinator commit `202e967`.

## Exact-source CI and archives

All six applicable workflows and all ten constituent jobs completed successfully on `bb59b51`; each job/step was inspected. Receipt JSON is saved as `final-bb59b51-job-<jobid>.json`.

| Workflow | Run | Successful jobs |
| --- | --- | --- |
| Validate | [40322974469](https://github.com/Deathstar1342/react-harness/actions/runs/40322974469) | 121572356772 |
| Desktop validation | [40322974483](https://github.com/Deathstar1342/react-harness/actions/runs/40322974483) | Windows121572357031; Ubuntu121572357181 |
| Private desktop support runtime | [40322974557](https://github.com/Deathstar1342/react-harness/actions/runs/40322974557) | Windows121572357223; Ubuntu121572357464 |
| Privileged helper | [40322974531](https://github.com/Deathstar1342/react-harness/actions/runs/40322974531) | 121572356765 |
| Container foundation | [40322974495](https://github.com/Deathstar1342/react-harness/actions/runs/40322974495) | 121572356697 |
| Guided container source desktop | [40322974466](https://github.com/Deathstar1342/react-harness/actions/runs/40322974466) | Ubuntu24:121572356436; Ubuntu22:121572356920; downstream Windows121575761296 |

The container probe retains existing foundation/worker/private-SQLite/M31 checks. Additions exercise a real pending worker writer blocking capture, normal real worker mutations and confirmed exact-context drain before restore, dirty leases and restart; a separate detached-child failure must remain failed/reset/uncertain, allow capture only after confirmed owned cleanup or refuse, leave no delayed marker and never replay. A detached-child command is never relabeled successful.

All nine fresh archives were copied to D, independently matched against published sizes/SHA-256 and checked for duplicate/case-aliased, traversal or symlink members. Metadata and the owned digest/path/UI receipt audit are `final-bb59b51-artifact-metadata.json` and `final-bb59b51-artifact-audit.json`.

| Artifact | ID | SHA-256 |
| --- | --- | --- |
| Container | 12649747857 | `8f8bf2b0f71e78cf57a58feefd85d5ac5542b8f7046ad00e97ec040add4cf9da` |
| Support Windows | 12650365968 | `69d8f9e6bd42ddfeab03a65424b1e51337c9743dd90cc3fdd4ea3da8de15afb5` |
| Support Ubuntu | 12649418270 | `b7bccc1ccb0e99ceaab977ec636e5d04c5c3c21e472bda55ab3bcddb92ca775e` |
| Source Windows receipt | 12650183060 | `487df6afdc534e1eb9a1687c98af37a17c0dc78bd7a2cbeaf9bf185f95888077` |
| Complete Windows source payload | 12649898725 | `a41bbe46b1e1358ede786ee6dab11bdca054daa61692a3210a6e1bd884a54e06` |
| Source Ubuntu22 receipt | 12649782508 | `c67d3f09edbadebfe391a965c08736f0d27d73a9b00d1687364ab6d804b931e8` |
| Source Ubuntu24 receipt | 12649359864 | `9bebe1d9217dec59f89d81aacfdd69c672d5e6b3dfff9cb783bb0f4c9071e25a` |
| Desktop Windows | 12650580530 | `ff697304df3b9f154ccea7182bc0c71709a5275e0f004acf633fd8ee0277593f` |
| Desktop Ubuntu | 12650331026 | `cb6621c67038699fc018cca4be59a503748d03485c76b2ee8598251cd55e76cf` |

Both desktop archives contain source-bound actual Chrome/Electron receipts with zero provider calls, no errors and staleStatus409, plus actual preview/restored PNGs. Support archives contain manifests/relocation receipts, not complete runtime payloads. Source Linux archives contain provenance and native source receipts. The complete Windows archive is 205,279,855 compressed bytes, 10,387 members / 587,468,393 uncompressed bytes. Coordinator independently verified its exact member set and all 10,386 manifest hashes, plus source/provenance and semantic coverage across all nine archives. This report relies on that explicit coordinator audit for complete inner-payload hashing rather than claiming a second child hash audit.

## Retained failures and corrections

Earlier receipts remain failures, not acceptance for the final source:

- Source-contained fixture temp was correctly rejected by sandbox; fixtures moved outside source. Git exclusion accounting included `.git`; Windows link coverage uses real unprivileged junctions. An observer-spy recursion and delayed constructor observation were corrected in fixtures.
- First full suite had an old agent-only history-copy assertion; updated copy and an explicit human attribution test match delivered behavior. Frozen d3 full suite had 1076 pass/47 skip plus one unchanged provider timeout case yielding transport after 6 ms. Focused unchanged cases subsequently passed, but attempted preload did not reach Vitest workers: the original cause remains unobserved. Provider code/assertions were not weakened; final frozen and coordinator full suites pass.
- d3 Desktop40316367411 Windows121549854966 failed because runner temp was a noncanonical alias; fixture-owned temp is now canonicalized, production refusal unchanged. Its Linux peer was cancelled, not passed. d3 Container40316367543/job121549855289 passed original steps but the new fixture wrongly expected success from a detached child; positive coverage now uses a normal worker command and separate negative cleanup/no-late-effect proof. Failed archives12647032593 (`e59e21413da79999d3a5b9c258f4139f781b3c643f29eed56514a5f9aee5c9cd`) and12646798862 (`6a2845a29dfe36e153e3e89c651b850aff30b35ca401c6692019dbf276633ad5`) and full job logs remain on D.
- `root-replacement-before-fix-20.log` and the coordinator's independent reproduction prove the original real product bug: replacing the root after intent with equal current bytes caused overwrite before final refusal. Every-effect live root/intent checks and owned-temp cleanup correct it; source `c1d712a` contains the safety fix. Final `bb59b51` adds only bounded compositor synchronization/report changes over that corrected candidate.
- Coordinator retained two hidden Electron `page.screenshot` timeouts after actual restore/history passed. The disposable host now uses actual sandboxed offscreen rendering, background throttling disabled and native `webContents.capturePage` with bounded readiness/nonempty dimensions. Fonts plus two animation frames synchronize the actual surface; stage records retain paint/frame/details-open diagnostics and PNG review. No production renderer or isolation setting changed. The first offscreen run also exposed a legitimate pending-watcher stale revision; a bounded quiet observation before the next deliberate preview fixes the fixture without request retry.
- Windows refuses parent rename with an open child. The temp-sentinel fault fixture records/closes/reopens the same real inode around the injected move and verifies device/inode; Linux exercises the actual open-handle move. The Windows controlled interleaving is explicitly distinct from Linux evidence.

## Limits and handoff boundary

Windows local evidence is actual disk SQLite/filesystem, Chrome and a sandboxed offscreen Electron test host. Disposable Linux CI supplies Linux/PTY/container/private-storage/worker evidence and Windows CI supplies source/desktop/support receipts. There is no Windows Docker Desktop D-bind/NTFS installed-device validation, native-human acceptance, clean-machine/customer package/signing/licensing acceptance or live-provider validation. STARK work remains deferred and is not represented as a checkpoint blocker. M21 Installer40322974475 is separately held and is not an M34 acceptance/release gate.

File restore does not undo commands, installs, external effects or chats; bounds/exclusions and durable uncertainty are intentional. No outstanding user assistance or source gate remains for this child. Report-only publication does not authorize main integration, successor work or release; those remain coordinator-owned under the current user instructions. The child stops after committing/pushing this report and leaves the assigned worktree clean.
