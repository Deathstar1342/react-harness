# M21 coordinator review

Reviewed child handoff `17d15ef2d5c516a2be9ebf3a8bc715362a3abe61`, tested/package source `bf420911b617e5790e1865384ed079cc527996c2`. The difference between them is only the child report. Implementation is approved for integration; final distributable acceptance remains open.

## Independent evidence

- Source review covered bootstrap/data-location validation, Windows process-owned maintenance exclusion, Linux runtime/admin leases and per-package completion markers, helper ordering, source receipts, package preparation and preservation/crash fixtures. Previous requested corrections are addressed. No provider prompt, planStep, public API or shared type changes.
- Exact-source run/job/step verification: [Validate](https://github.com/Deathstar1342/react-harness/actions/runs/38560442851), [Desktop](https://github.com/Deathstar1342/react-harness/actions/runs/38560442896), [helper](https://github.com/Deathstar1342/react-harness/actions/runs/38560442863) and [installers](https://github.com/Deathstar1342/react-harness/actions/runs/38560442883) passed. Linux Validate reports 680 tests / 7 skips. Actual package install/remove/reinstall, preserved records, interrupted maintenance, repair and main-process crash checks are CI evidence, distinct from local device acceptance.
- Independent Windows typecheck, full portable suite **654 passed / 33 skipped**, desktop production build and baseline diff check passed. Python maintenance tests cannot run on Windows because `fcntl` is Linux-specific; verified Linux CI covers those tests.
- Recomputed original archive/package SHA256 hashes match the child report. Windows Authenticode is **NotSigned**. Extracted the original NSIS embedded payload and ran its actual executable with `tests/packaged-smoke.ts` in a fresh D: profile: every setup file/checksum, Electron42.11.13/Node24.19.0/N-API10 with stable N-API8 lease, production entry, renderer sandbox, second-instance and restart passed. No installation, backend connection or privileged transaction was performed on the user's workstation.
- Windows installer: `e0167da08c7d72723b6cb1e8ba647dcd8c40928cf9e4a1d8402e08cb7836c9d3` (199794147 bytes).
- Ubuntu desktop: `92ba7fb77def2e4ca8e436242500b792965c988a85b9ad6387840bad3c59da65` (191156104 bytes).
- Ubuntu backend: `6ac96850baed06b5ff23ba25d20e08837ead162ab9af19f86922162ad6624456` (66136634 bytes).
- Optional helper staging: `5b241bc887708e9ff56a98b725c0e3798a056866c589b5f149a13f0707a8757a` (328748 bytes).

These hashes identify the reviewed branch-source artifacts. A build of integrated main has a new embedded source identity and requires its own receipts; do not mix backend and desktop sources.

## Retained coordinator failures

The first portable test run used the C: junction alias for TEMP and returned 652 passed / 2 failed / 33 skipped because canonical storage paths differed. Rerunning with the physical D: directory passed without changing source or weakening path checks. The original logs remain local review evidence.

7-Zip16.04 extraction into a long review folder failed on 27 nested Monaco paths. Extraction of the same original archive into a shorter D: review directory completed, then all packaged smoke checks passed. This is an extraction-tool/path limitation observed during review, not evidence of an NSIS install failure or acceptance of arbitrarily long install paths. The partial failed extraction is retained and was not launched.

## Remaining acceptance

Exact-main CI follows integration. Final publication still requires the explicit [acceptance record](../release-acceptance.md): assisted installer/folder/cancel interaction, clean Windows11/Ubuntu24.04 WSL2 deployment, native pickers, graphical OS-auth allow/deny/cancel/repair, real privileged-install desktop close and the complete installed workflow. Work-network STARK remains the user's deferred test; no credentials are requested here. Bundled redistribution notices/source availability need final publication review. Unsigned status and unproven cross-host byte reproducibility must remain explicit.

No release, milestone closeout, M22, existing preview update, helper provisioning or modification of the user's WSL/projects is authorized by this review alone. Preserve earlier worktrees/branches and user data.
