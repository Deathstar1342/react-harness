# Milestone 21 — Installer candidate (work in progress)

Isolated `codex/milestone-21`, base `6f99a5345f59b5099612d579edc0fb52e9fe2dfa`, worktree `6fd9`. Coordinator-approved packaging and native lease contracts. This report is not milestone closeout or release acceptance. The user's installed preview, Ubuntu-24.04 WSL environment, Podman environment, M20 branch/worktree and local data remain untouched.

## Candidate scope

Assisted unsigned Windows x64 NSIS installer, Ubuntu24.04 x64 desktop/backend .debs and optional helper staging package. Windows separately selects app and desktop-data folders; Linux profile/project storage remains explicit. Windows updates use close/uninstall-app-files/reinstall, preserving the saved data location. No in-place updater, WSL provisioning, password IPC, host-shell fallback or automatic helper authority. The production CJS entry fixes packaged ESM readiness. Release input hashes, native ABI/runtime probes, payload receipts, license notices and disposable package workflow are included.

See [release procedure](../release.md) for contracts and [setup guide](../installer-setup.md) for user steps. Shared/types.ts, public API, provider prompts, planStep, per-chat model snapshots and approval contracts are unchanged. Narrow internal changes: packaged source identity/launcher selection, installation leases, native bootstrap and helper administrator maintenance refusal.

## Evidence so far

- Local Windows full suite: **648 passed / 33 skipped**, typecheck, desktop build. One further preflight regression now passes: **9 focused packaging checks**. Fresh final-source full checks remain to be recorded.
- Actual Windows packaged `.exe` production entry (no test CJS launcher): isolated D: data path, sandbox/no renderer Node, normal second launch, restart and sentinel preservation passed. Native main-process mutex loads in pinned Electron. No local NSIS install or WSL mutation was attempted.
- Source `bc272f366aa8acb3b921d6ce63a30697f1145035`: Validate [38543688880](https://github.com/Deathstar1342/react-harness/actions/runs/38543688880), Desktop [38543688871](https://github.com/Deathstar1342/react-harness/actions/runs/38543688871), helper [38543688946](https://github.com/Deathstar1342/react-harness/actions/runs/38543688946) succeeded. These are earlier source evidence, not final delivery.
- Initial package workflow [38543689040](https://github.com/Deathstar1342/react-harness/actions/runs/38543689040) built the .debs, installed them and passed installed Linux Node/SQLite/native PTY/sandbox checks, but hung during desktop cleanup and was cancelled by the superseding candidate. It is **not** a package pass. The subsequent native lease removes the subprocess lifetime defect and tests now have a deadline.
- Source `5bda110b916bbb6e3f346a0f7a9e3dd0e4efbfc4`, Linux job `115788576473` in [38544907320](https://github.com/Deathstar1342/react-harness/actions/runs/38544907320) passed actual packages and connected backend, removal/reinstall and fresh relaunch. Its sentinel was separate from app state: this does **not** prove actual chats/settings survived reinstall. The next test keeps one real desktop/profile, records actual project/chat/model/settings/file data, and separates creation from verification across both desktop/backend removal/reinstall.
- That run's Windows job `115790953294` built NSIS but failed a test comparison between `RUNNER~1` and canonical `runneradmin` for the same data path. The test now compares real paths; production already canonicalized correctly. NSIS lifecycle steps were not reached in that run.
- Source `065ac60a520ca5b728f8c1050b988a351f386e0c`: full Validate/Desktop/helper workflows succeeded. Package job `115793632974` passed actual same-profile/chat/project/model/settings/file preservation through both backend and desktop removal/reinstall, native lease refusal and interrupted-unpack/failed-postinst repair. Optional helper removal then failed: the guard treated dpkg's desired `deinstall` selection after a refused backend removal as unsafe despite current `ok installed` state. The correction checks current error/status fields while retaining payload/authority checks; final rerun remains required. This failed run is not a full package pass.

## Retained failed evidence and review corrections

- Sandbox Vite build hit `EPERM realpath` in Monaco. The same isolated D: build succeeded with normal permissions; source behavior was not weakened.
- Initial full suite put TEMP inside the installation checkout, producing **83 failures / 557 passes / 33 skips** and a project-overlap rejection. Moving fixtures to the separate permitted D: visualization temp root produced the full pass above. No sandbox rule was loosened.
- First electron-builder config used unsupported `beforeInstall`/`beforeRemove` keys; pinned schema requires FPM options. First NSIS compile rejected an unused uninstaller variable; declarations now match installer scope.
- Coordinator identified a lease-child crash hole and second-launch ordering regression. The lease is now owned by the native main process, not a PowerShell child; its lifetime cannot end before main process exit. No forced shutdown workaround.
- Coordinator required installer-time canonical path validation and per-package Linux interruption state. Preflight now rejects invalid locations before copying/persisting; a focused test additionally caught drive-root trimming (`C:\` becoming drive-relative `C:`), now explicitly rejected. Linux completion verifies payload/source/package state and owns only its own marker.
- Broad `git add -A` was rejected by automatic approval review because generated artifacts might be staged. Only explicit reviewed source/test/docs/workflow paths were staged afterward. No artifacts or credentials were committed.

## Remaining delivery/release gates

Package CI and artifact receipts are still in progress. Native picker/UNC/cancel, graphical OS authentication allow/deny/cancel, actual desktop-close-during-privileged-install, clean Windows/WSL VM acceptance and full installed workflow remain outstanding. Work-only STARK is separately deferred. Signing credentials are absent; unsigned status is explicit. Debian is not claimed from Ubuntu ABI evidence. Bit-for-bit cross-host reproducibility is unproven.

Coordinator owns final review, main integration, release publication, STATUS and closeout. Do not treat this checkpoint as delivery or alter the live workstation to satisfy those gates.
