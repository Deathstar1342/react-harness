# Candidate acceptance record

M27 validates existing packaging integration against redesigned source only. It does not resume M21's paused corresponding-source/notices work or waive any gate below. Frozen source, synthetic evaluation, portable/browser/Electron, disposable Linux CI, installed-device and live-provider evidence remain separate; see [integrated evaluation](integrated-evaluation.md) and the [work diagnostic](../scripts/README.md).

Record the exact source/artifact SHA256, Windows build, WSL version, explicitly selected distro version, username and installation/data paths without keys. Use a disposable authorized VM for privileged/package work. Do not use the developer's existing preview or live WSL project as a test target.

| Gate | Required evidence | Current classification |
| --- | --- | --- |
| Clean package portability | Installed runtime and application command links resolve within the installed payload or intended system paths after the build checkout is unavailable; inspect links independently of regular-file manifests | **FAILED in M27 archive audit:** ten backend command links, including npm/npx/corepack, target absent CI build paths. M21 correction and clean-layout regression required; successful runner install tests do not waive this failure. See [independent M27 review](reports/milestone-27-coordinator.md). |
| Internal payload integrity coverage | Every final installed payload file is covered by the internal integrity manifest or an explicit verified exclusion; late builder additions tested | **INCOMPLETE in M27 Windows archive:** late `resources/elevate.exe` is absent from the inner manifest, although its outer SHA256SUMS hash matches. M21 must review the final-manifest boundary; matching listed entries is not full internal coverage. |
| Windows installer | Real assisted folder choice, D: app/data choice, wrong/UNC/root/junction path refusal, cancel, missing saved drive, repeated install, uninstall/reinstall | Automated disposable NSIS checks plus manual assisted-page receipt required |
| WSL setup | No default/service distro selected; explicit Ubuntu24.04 WSL2; bundled backend installation via normal OS package tools; runtime/PTY/sandbox ready | Clean Windows/WSL VM receipt required |
| User data | Same profile/project/chat IDs, model snapshots, settings, key/config hash, project bytes, caches after restart and package maintenance | CI records actual Linux state; Windows/WSL end-to-end receipt required |
| Native picker | Choose Linux folder through WSL UNC, wrong distro/Windows drive rejected, cancel unchanged; native Linux folder picker | Human/device receipt required; returned test dialog values do not satisfy it |
| OS authentication | Enable, deny, cancel; repair with damaged descriptor; trusted removal; normal user backend | Real graphical agent receipt required; CI policy allow/deny is separate |
| Privileged close | Actual desktop close during an authorized real package transaction, wait/drain, uncertain record after crash, no replay on restart | Disposable graphical VM receipt required |
| Installed workflow | Configure work endpoint → import/create → plan → approve/build → project-local dependency → all three system-install policies → edit conflict → restart | Explicitly label synthetic versus live provider results |
| Offline/work network | Node/runtime present without developer tools; identify remaining apt/WSL/auth-agent prerequisites and proxy/repository policy | Do not claim fully offline bootstrap from bundled .debs alone |
| Signing | Windows Authenticode and any Linux signing/repository identity verified independently | Unsigned candidate unless a future release says otherwise |

Do not turn a failed/cancelled/no-agent/unsupported-host attempt into a pass. Keep the failed receipt, record whether state was preserved, and rerun only the affected gate after the actual correction. The coordinator decides final platform support and publication after reviewing both automated and manual records.
