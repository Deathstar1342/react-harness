# Milestone 18 — Narrow privileged apt helper

Delivery branch: `codex/milestone-18`, isolated worktree `c7f7`.
Base: `0e2315c0f803f2f41c7ef765cf59a9ecaa973728` (M17 delivered plus coordinator delivery documentation).
Coordinator: `01a0dc0a-8866-7182-acd2-da997779962d`.
Source candidate and exact final CI: pending completion; this report is not a delivery claim.

## Scope and contracts

M18 only: static privileged bootstrap, explicit administrator setup/repair/uninstall, authenticated versioned Unix protocol, first apt adapter, durable single-use decisions and uncertainty, trusted TypeScript client, narrow file/sandbox exclusions and tests/docs. No main merge, M19 policy/model action/UI, Electron or workstation provisioning. Coordinator approved Python stdlib/python3-apt, static C bootstrap and private apt-only import directory. No npm dependency/lockfile change.

The app remains non-root and never starts/provisions the helper automatically. The helper accepts only structured apt identities, resolves concrete authenticated new packages/dependencies, binds target/metadata/installed state/impact to a digest, and independently revalidates under real package-system locks. Existing package changes/removals and unknown/unbounded metadata fail closed. Already-installed requests are no-ops. Approved maintainer scripts and dpkg triggers are a deliberate root execution exception with possible effects on existing packages/services; metadata limits do not bound those scripts' behavior.

The trusted client exposes hello/prepare/authorize/execute/status/reconcile. Shared DTOs and API documentation are additive, with no HTTP entrypoint. Existing M16/M17 lifecycle, credentials, namespace/registry capability and cleanup/quarantine behavior remain. Fixed helper directories are excluded from file/project roots; code inside `/usr/lib` is additionally masked from agent mounts. See [operating/security contract](../helper.md) and [wire contract](../api-contract.md#m18-trusted-package-helper).

Root-private SQLite records preparation/authorization/running state before package effects. Restart invalidates pending authorized decisions and preserves running uncertainty. Lost replies are never retried. Reconciliation records actual package state separately and cannot rewrite uncertainty as success. Repair rotates credentials and preserves target/audit; uninstall removes authority and leaves installed packages and durable audit/identity intact. Unhealthy or unreconciled uncertainty blocks further installs.

## Validation in progress

- Windows Node 24.16: typecheck passed; full Vitest suite **527 passed / 33 platform or optional skips**; production build passed with the inherited large-chunk warning. Follow-up helper-specific changes require the final candidate verification recorded below.
- Portable Python state/adapter suite: **18 tests passed**. These are policy/durability checks, not root-install evidence.
- Real service startup, root-owned ACL descriptor, non-root TS HMAC client, unauthorized local UID denial, replay/expiry/forgery checks, private import sentinel denial, actual namespace exclusion with a live helper, and dpkg frontend-lock conflict have executed successfully in disposable Ubuntu CI. The complete privileged transaction/recovery workflow is still being finalized; no completed Linux delivery claim yet.

## Preserved failed evidence

| Candidate / evidence | Failure and disposition |
| --- | --- |
| Local dependency/test bootstrap | Sandboxed npm exit-handler failure and Python temporary-directory SQLite access failure. Authorized normal-access local commands passed; no root operation was attempted locally. Initial Git commit lacked identity; explicitly authorized per-command identity was then used. An initial branch push contained only the existing baseline. |
| `186eb46`, [38503821696](https://github.com/Deathstar1342/react-harness/actions/runs/38503821696) | Static C build rejected missing `clearenv` declaration under `-Werror`; feature macro corrected. Ordinary application Validate passed. |
| `d087316`, [38504003944](https://github.com/Deathstar1342/react-harness/actions/runs/38504003944); `17fd077`, [38504284439](https://github.com/Deathstar1342/react-harness/actions/runs/38504284439) | Launcher rejected runner `/usr/share`: actual root:root mode 0777 and inherited default runner:rwx ACL. Disposable fixture records and removes that ACL, sets root:root 0755. Production continues rejecting it. |
| `3bb3186`, [38504484237](https://github.com/Deathstar1342/react-harness/actions/runs/38504484237) | Scanning all unrelated distro Python packages reached untrusted `/usr/share/ieee-data`. Narrowed both validation AND import resolution to apt/apt_pkg/apt_inst and stdlib, without normalizing unrelated package data. |
| `4586788`, [38504661226](https://github.com/Deathstar1342/react-harness/actions/runs/38504661226) | Heuristic byte scanning misread loader-cache binary bytes as a pathname. Replaced with bounded indexed modern glibc cache parsing. |
| `453cc89`, [38504988751](https://github.com/Deathstar1342/react-harness/actions/runs/38504988751) | Real loader-cache validation rejected hosted Swift library targets under writable `/usr/share/swift`. Disposable fixture uses explicit distro-only loader configuration/cache; production never rewrites loader policy. |
| `5830ba9`, [38505164167](https://github.com/Deathstar1342/react-harness/actions/runs/38505164167); `316fae0`, [38505407514](https://github.com/Deathstar1342/react-harness/actions/runs/38505407514); `9169cb7`, [38505548510](https://github.com/Deathstar1342/react-harness/actions/runs/38505548510) | Safe new package rejected as existing change. Read-only probe proved `hello` had installed=false, marked_install=true AND marked_upgrade=true. Gate now uses actual installed state, retaining dependency mutation/removal/downgrade/reinstall rejection. Installed candidates also remain pinned to current versions to prevent opportunistic upgrades. |
| `ec0dc4a`, [38505663694](https://github.com/Deathstar1342/react-harness/actions/runs/38505663694) | Preview rejected a transient auxiliary mirror-list symlink. Exclude partial/auxfiles subtrees from authoritative fingerprints; they are not active signed package indexes. |
| `a11b2ca`, [38505921330](https://github.com/Deathstar1342/react-harness/actions/runs/38505921330) | Actual apt installation passed, then the writable `/usr/share` parent regression failed after narrower runtime imports stopped traversing that parent indirectly. Added explicit trusted common package-data-parent validation; did not remove the negative assertion. |
| Initial portable adapter tests | Test-only sys.modules restoration created two Rejected class identities; imported core before patching modules. All 18 focused tests then passed. No production policy relaxation. |

## Environment and acceptance limits

Privileged tests run only in disposable GitHub Ubuntu 24.04 x86_64 VMs with explicit sudo setup and fixed representative repository packages. These VMs need **non-stock fixture preparation**: root-only `/usr/share` permission/ACL normalization, distro-only loader configuration/cache, direct Ubuntu HTTP source instead of hosted mirror-list indirection followed by apt update, and enabled unprivileged user namespaces for the live M17 boundary check. The original rejected metadata and failed run links are retained. These results cannot be called untouched Ubuntu, WSL or installed-desktop acceptance.

No helper/packages/kernel/service policy were provisioned on the developer workstation; Podman WSL was untouched. No live-provider credentials or STARK acceptance. Debian/WSL/distribution matrix, Electron authorization UX and release signing/packaging remain later target-device gates. Root administrator/OS/package trust and same-user unsandboxed host processes remain explicit assumptions; this is not protection against an already malicious root, arbitrary concurrent administrative replacement, or shared-kernel/resource exhaustion.

The inherited npm audit reports five vulnerabilities (two low, one high, two critical); no unrelated dependency changes were made. Generated binaries, build output, databases, credentials and project contents are excluded from commits. Coordinator owns independent final review, integration and main publication.
