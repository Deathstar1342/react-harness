# Privileged package helper (M18)

The backend remains non-root. System installs are unavailable unless an administrator explicitly provisions the helper in the **selected Linux/WSL environment**. Starting the app neither provisions nor starts the service. There is no M18 model action, browser API, settings policy or install-approval UI. The trusted backend adapter is `server/package-helper.ts`; M19 supplies policy decisions and M20 supplies the guided OS authorization flow.

## Prerequisites and trust

Initial adapter: x86_64 Ubuntu/Debian, systemd, distro `/usr/bin/python3`, `python3-apt`, `acl` (`setfacl`), apt/dpkg, and the usual GNU loader layout. The release build needs `cc` and static libc; the installed system needs no compiler, Node modules or pip packages for privileged execution. Unsupported architectures, managers, runtimes and unsafe permission hierarchies fail closed. Actual evidence and exact tested versions belong in the M18 report; this is not blanket WSL/distribution acceptance.

A trusted OS administrator/package installer must first verify and install the release artifact into `/usr/lib/abyssus-helper`, owned by root with non-writable ancestors. Never run a checkout, downloaded script, npm lifecycle or user-writable Python module as root. The administrator's OS authentication prompt owns the password; no password is accepted by the helper or passed through the renderer/model. M18 has no passwordless sudo rule or setuid binary. The CI workflow's explicit root staging is a disposable test setup, not an end-user installer.

The static C launcher validates the root-owned helper tree, stdlib trees, apt package and native modules, system libraries, cached native library paths and their ancestors before executing Python with `-I -S`, fixed argv, fixed environment and `/` as cwd. It rejects non-root ownership, group/other write (including POSIX ACL write masks), default directory ACLs, unsafe symlink targets, nonempty loader preload files, excessive depth/entry count and missing prerequisites. Directory identities deduplicate symlink traversal. Only a root-owned private import directory containing validated links to `apt`, `apt_pkg` and `apt_inst` is appended after stdlib; broad distro dist-packages is never importable. Unknown transitive packages fail closed. Trusted staging must create these three links for the installed distro Python ABI. Root-provisioned OS executables, libraries and package-manager configuration are trusted code, not protected against a malicious root administrator. Administrative mutation during operation is unsupported; stop the helper first. This is not a cryptographic attestation of the operating system.

## Explicit administrator entrypoints

After trusted staging, OS authorization may invoke only these fixed entrypoints:

```
/usr/lib/abyssus-helper/launcher setup <numeric-non-root-backend-uid>
/usr/lib/abyssus-helper/launcher repair
/usr/lib/abyssus-helper/launcher uninstall
```

Setup refuses an existing configuration. It creates a root-owned configuration, private durable state, single authorized UID, per-installation identity, root-owned client descriptor with an exact read-only UID ACL, and a systemd service. Repair stops the complete service control group, preserves installation identity/audit, rotates credentials, reinstalls the service definition and starts it. Neither operation installs system packages or repairs dpkg. The trusted client must obtain a valid signed `hello` before declaring the helper ready. Declining OS authorization leaves system installs disabled.

Uninstall stops/disables the service and removes its unit, code and credentials. It preserves `/var/lib/abyssus-helper` (audit and installation identity), installed packages, app data and all projects. A later explicit setup reuses that identity and recovery history. It never removes packages. Recovering a broken apt/dpkg system is a separate administrator operation, never an automatic helper retry.

## Authentication and containment

The socket is `/run/abyssus-helper/control.sock`, in a root-controlled directory. Kernel `SO_PEERCRED` must match the registered UID; versioned HMAC requests and responses additionally authenticate possession of the root-created client credential. `/etc/abyssus-helper/client.json` is backend-only, never renderer/model/agent input. The supported principal is the authorized local account, not a defense against other unsandboxed processes already running as that account.

Helper code/config/state/socket paths and their ancestors cannot be project roots or file-tool roots. M17 namespaces exclude config/state/socket; the helper code under `/usr/lib` is additionally covered with an empty read-only mount. Ordinary npm/pip installations continue through M17's registry-only namespace. No helper token or socket is granted to that boundary.

## Package policy and exact authorization

`prepare` accepts an apt package name and optional exact version. Omission resolves the current configured candidate; explicit versions cannot be substituted. The concrete preview includes the full new dependency closure, exact versions/architectures, authenticated archive SHA256, download/installed-size totals, source URIs and repository origin/label/archive/component/site. Existing requested packages at the requested version are an explicit `noop`; an existing package version change, reinstallation, removal or downgrade is rejected. The first adapter admits only authenticated Ubuntu/Debian-origin packages from fixed HTTP(S) repositories. Mirror-list indirection, local `.deb` paths, repository edits, source scripts, arbitrary options/environment/configuration and whole-system upgrade are unavailable.

Maximum 16 requested packages, 32 new resolved packages, 128 MiB download and 512 MiB declared installed size. Essential package installation, unknown provenance/hash/size, insecure trust overrides, broken/interrupted dpkg and unsupported dependencies reject. These metadata bounds are **not** limits on the arbitrary effects of approved package scripts. Maintainer scripts and dpkg triggers run as root and may change existing packages/services, spawn processes or consume resources. The preview explicitly declares this trusted-package exception. Package descriptions and process output do not supply instructions or authority.

The preview digest binds the selected target (installation/machine/distro/release/architecture), requested/resolved transaction, installed-state fingerprint, apt configuration/source/preferences/index fingerprint and impact. A separate single-use decision binds that digest, request ID, random decision nonce and expiry (within the preview's two-minute lifetime). The trusted caller supplies decisions only after M19 policy has validated a real approval; prose is never interpreted here. Every execute re-resolves under global helper serialization plus actual apt frontend/dpkg and index locks before effects. No conflicting helper instance or project can run another transaction. A stale plan, lock conflict or changed target consumes an attempted execute as failed; explicit new preparation is required.

## Durable outcomes and recovery

Root-private SQLite uses synchronous FULL transactions and an append-only event history. Prepared, authorized and running records are saved before package effects; success requires both apt completion and observed installed versions/healthy package state. Process output is suppressed; audit diagnostics are bounded fixed codes and structured observations, never raw package text or credential-bearing repository messages. At most 10,000 requests are admitted; reaching capacity requires explicit administrator maintenance, not automatic deletion of evidence.

A restart expires authorized records and changes running records to uncertain. No root operation is replayed. A lost client reply is `HELPER_REPLY_UNCERTAIN`; callers use status/reconcile, never retry execute. Reconciliation records actual package versions and package-system health separately and never turns an uncertain original outcome into success. Unreconciled uncertainty or unhealthy partial dpkg state blocks new preparation/execution. A healthy reconciliation permits a fresh separately authorized request while retaining the old uncertainty. Repair and credential rotation retain these records.

References: [python-apt package-system locking](https://apt-team.pages.debian.net/python-apt/library/apt_pkg.html#locking), [Cache commit/install locking](https://apt-team.pages.debian.net/python-apt/library/apt.cache.html), [package provenance metadata](https://apt-team.pages.debian.net/python-apt/library/apt.package.html).
