# M21 candidate build and release procedure

The coordinator owns release publication. Candidate workflows upload artifacts to GitHub Actions; they do not create a GitHub Release, sign, merge main or update installations. Do not distribute a work-in-progress artifact as an accepted release.

## Locked inputs and build hosts

- Electron **42.11.13**, electron-builder **26.15.3**, Node Linux x64 **24.16.0** and npm production packages from `package-lock.json`.
- Node archive SHA256: `d804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9`, verified before extraction. Runtime manifest checks the actual Node executable hash, version, module ABI/platform/architecture; staging loads SQLite/node-pty and CI executes real PTY/sandbox probes.
- The packager's exact npm integrity is `sha512-a1KM5heqS3gQCZzizXEI8RjJy3QVogULPdeSknt76uLDpBIW/HDGsMg/XgP0riP6PI9COsRvFITKKGDqA8fJxA==` (MIT). Its pinned tools/checksum manifests and Electron download verification apply; do not substitute arbitrary mirrors or disable verification.
- Ubuntu **24.04 x64** builds the backend/runtime and helper staging packages. The helper binds to that distro's Python APT ABI. Windows x64 builds NSIS and its native main-process lease with the Windows SDK C compiler. Ordinary users do not need these build tools or developer Node/npm.

On Ubuntu: `npm ci`, `npm run desktop:build`, `npm run desktop:stage-runtime`, the runtime probe, `node scripts/backend-package.mjs`, `node scripts/helper-stage.mjs --release`, copy the helper .deb into `build/bundled`, then `npm run package:prepare`, checksum the bundle, and `npm run package:linux`. The workflow is the executable source of truth for order and package acceptance.

Transfer the complete **same-commit** `bundled-linux-payload` artifact to the Windows job. Build the desktop, prepare the package and run `npm run package:windows`. Keep Node/npm/Electron/builder caches and TEMP on a volume with room. For this developer workstation, all such paths are on D:, and test fixtures are outside the repository so the sandbox's install/project overlap rule remains effective.

The builds have locked inputs and recorded output hashes. **Byte-for-byte reproducibility across compilers/hosts is not established**; NSIS/toolchain metadata can differ. A repeated build must be independently verified and get its own checksums. No generated artifact belongs in Git.

## Trust and maintenance

The Windows native lease uses a stable product-specific global mutex held directly in Electron main. It has no JS release function or disposable lease child. The installer/uninstaller uses the same mutex and refuses active ownership. Normal second launches first use Electron's existing per-data-directory single-instance focus behavior. Different installation paths/users are conservatively excluded by the product-wide mutex; this first candidate does not support parallel desktop installations. Access denial or foreign named objects fail closed. An abnormal main exit releases its OS mutex; any surviving WSL backend still owns the independent Linux package lease until its existing cleanup completes. Windows app-file removal does not remove WSL runtime files or claim that uncertain backend work completed.

The native module implements only stable N-API registration and three function signatures checked against [Node's primary C header](https://github.com/nodejs/node/blob/v24.16.0/src/js_native_api.h) and [module entry definitions](https://github.com/nodejs/node/blob/v24.16.0/src/node_api.h). Actual pinned Electron package tests verify loading/exports. No header/runtime download, native Node ABI rebuild or new runtime package is needed for that small lease. Linux uses the same module to hold a shared `flock`; the dedicated backend launcher separately inherits its own shared lease for its full lifetime.

Linux dpkg scripts obtain exclusive runtime/admin locks and create root-owned per-package maintenance markers before releasing the locks for replacement. New launches require both a shared lease and absence of maintenance markers. Each completion verifies installed backend, desktop and optional helper payloads plus matching desktop/backend source and other package state; it clears only its own marker. No package enables helper authority. Enabled/configured authority blocks maintenance until the trusted M18 removal path has completed. Dependency ordering keeps staged helper code and its backend prerequisites available. A failed/uncertain transaction remains blocked for explicit package-manager repair.

Package inventories are SHA256 consistency receipts, not signatures or protection against an administrator replacing both code and receipt. The Windows data-location file is bounded, strict and data-only. Canonical checks reject device/UNC paths, roots, traversal and overlaps with installation/OS paths including junctions. A saved unavailable location fails instead of selecting C:. An explicit `--user-data-dir` must match the saved selection. The installer writes the location through a temporary file/rename and preserves the selected path independently of removed app files. No data migration or profile merge is implicit.

## Release evidence and signing

Retain the exact source SHA, required CI job/step results, `.exe`/`.deb` sizes and SHA256 checksums, license notices, failure receipts and separate platform evidence. Electron's own notices accompany the desktop; Node's license and dependency notices accompany the Linux payload. Review bundled notices before redistributing. Unsigned output must say **unsigned**; the packager's hook names or log wording are not proof of signing. Verify Windows Authenticode status explicitly. A future signer integration requires separate identity/credential provisioning; keys must never enter the repository, renderer, artifacts or shell children.

Release gates: actual NSIS install/refusal/uninstall/reinstall; actual Ubuntu .deb install/connected backend/removal/reinstall; held-process maintenance refusal; interrupted unpack/failed postinst/repair; source mismatch and payload damage; native module ABI; data preservation; missing prerequisites. Existing full runtime/helper suites remain necessary but do not replace installed-package checks.

Manual gates still requiring separate receipts: clean Windows 11 + selected Ubuntu24.04 WSL2 installation, native picker/UNC/cancel, real graphical authorization allow/deny/cancel, closing the real desktop during an actual privileged install, complete installed workflow and work-network STARK. CI provider fixtures and policy allow rules are explicitly not human/device/live-provider acceptance. Follow [installer setup](installer-setup.md) and [WSL validation](desktop-wsl-validation.md).
