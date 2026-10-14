# M20 Windows/WSL acceptance procedure

Status: **NOT RUN**. This procedure is a gate, not evidence of a pass. Use PowerShell 7 in a disposable Windows x64 VM with nested virtualization. Do not use or repurpose a workstation/Podman/service distro. Provisioning this environment requires the owner's separate decision. Live work-network STARK remains a separate deferred acceptance check; it is not required to prepare this VM.

## Provision once in the disposable VM

- Windows Node 24+, Git, and this exact reviewed branch/commit; use a checkout containing no credentials or personal projects.
- Explicit supported Ubuntu/Debian **WSL2**, a non-root default user, WSL localhost forwarding, systemd, Bubblewrap with working user namespaces, bash, git, socat, Python 3 + venv, and a working graphical polkit authentication agent. WSLg alone is insufficient. Record actual Windows/WSL/distro versions.
- In a Linux checkout at the **same source SHA**, run `npm ci`, `npm run desktop:build`, `npm run desktop:stage-runtime`. Administrator-stage the resulting `build/app` and `build/runtime` as root-owned `/opt/abyssus/app` and `/opt/abyssus/runtime`. Keep all source projects and profiles outside those directories. Do not reuse Windows `node-pty` binaries.
- On that Linux distro build `node scripts/helper-stage.mjs` and have the VM administrator install its data-only `.deb` with the OS package manager. This is the reviewed M20 scaffold, not a signed/final M21 installer. Do not run setup yet. Do not add passwordless polkit rules for the manual authentication checkpoints.
- Create a disposable Linux project directory with `sample.txt` containing `original`. Record its path; no personal project content is needed. For migration use a separate synthetic legacy fixture and a second fresh profile, never the only copy of real user data.

## Start the committed validation runner

From PowerShell 7 in the Windows checkout (replace distro/user only):

```powershell
./scripts/desktop-wsl-validate.ps1 -Distribution Ubuntu-24.04 -ProfileHome /home/tester/abyssus-m20-acceptance
```

The runner explicitly starts only that distro, refuses an existing profile or evidence folder, records safe prerequisite/build/shell-smoke output, and opens real Electron with an isolated desktop profile and preselected environment. It performs no distro/helper installation or data deletion. Choose **Initialize a new profile** for this first launch. Failures preserve evidence under `test-results/wsl-manual`; use a new evidence directory for another attempt.

For subsequent window launches, retain the same desktop selection without rerunning the fresh-profile gate:

```powershell
$env:ABYSSUS_SMOKE_HOME = (Resolve-Path ./test-results/wsl-manual/desktop-profile).Path
./node_modules/.bin/electron.cmd ./tests/desktop-electron-entry.cjs
Remove-Item Env:ABYSSUS_SMOKE_HOME
```

## Record each checkpoint in the evidence copy

For every item record PASS/FAIL/NOT RUN, time, actual result and a screenshot where useful. A cancelled operation is only a pass if the cancellation checkpoint's preserved state is verified. Do not include passwords, API keys, `.env`, `backend.json`, databases, helper credentials or personal projects in evidence or Git.

1. Confirm displayed distro/profile before startup; runtime/SQLite/PTY/sandbox/toolchain checks pass. Decline optional helper and reach ordinary chats. Verify system-install authority remains disabled.
2. Native import picker: cancel and preserve current selection/editor; choose the synthetic folder through `\\wsl.localhost\SelectedDistro\...`; mismatched distro and Windows drive paths are rejected. Open/edit/save `sample.txt`; verify Linux disk content, dirty guard and conflict behavior.
3. Create a chat and inspect live updates. Close normally; reopen **existing** profile and verify chat/project/settings/file persistence. Launch the second Electron command while the first is open: it focuses the first window with one backend. Launch from another Windows working directory too.
4. In Desktop setup, cancel the application's helper confirmation: backend and authority remain unchanged. Then continue to a real **OS authentication prompt and Cancel**: no helper authority appears; reopen the existing profile and safe app use still works. Repeat with **OS denial** (unauthorized account/policy), record actual denial. Never record passwords.
5. **OS allow**: explicitly authorize helper setup. Verify signed helper target matches selected distro. Reopen profile; repair through another real OS prompt and preserve installation identity. Remove through OS authentication; verify authority/unit/socket/credentials removed while audit, project files, chats, settings and installed packages remain. Record agent/polkit versions. Do not treat native-dialog cancellation as OS-prompt cancellation.
6. With a synthetic disposable fixture, exercise migration and restart; verify original legacy data/receipt preserved and imported records match. A failed/occupied/missing profile produces an actionable setup state. Retain failures; do not initialize over missing data.
7. In the disposable VM only, exercise renderer crash and backend crash using the exact owned process identity. Record any lost unsaved renderer text warning. Backend recovery is explicit, never automatically replays commands, and creates a fresh window/session. Dirty buffers prevent profile replacement until deliberately discarded/copied. Confirm same-profile and second-profile state separation.
8. Using the existing reviewed synthetic helper/install fixtures in the disposable environment, hold a real install in progress and close the desktop: it waits for local drain, preserves uncertain receipts, and never promises rollback. Record process/service/audit outcome. Do not infer this desktop checkpoint from lower-layer CI alone.
9. Record endpoint/key Settings and explicit Test connection against an authorized synthetic/local service if available. Work-network STARK is separately marked NOT RUN unless actually available; never request/store its credentials in evidence. Do not label a synthetic response live-provider acceptance.

## Evidence and cleanup

Retain source SHA, safe version/prerequisite/build/smoke logs, screenshots, completed checklist, precise failures and test-only fixture descriptions. Share only those safe files. The evidence folder also contains a private Electron profile: do not upload that entire folder blindly.

Close Electron normally and wait for its owned backend to exit. Remove helper authority through the verified OS-authenticated flow; leave audit and installed packages intact. Preserve all profile/project data and evidence. Prefer retaining or reverting the disposable VM snapshot after review; do not unregister a distro, kill unrelated processes, delete profiles, uninstall packages or clean user data automatically. The runner intentionally performs no cleanup deletion.
