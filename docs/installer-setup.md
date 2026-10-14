# Install abysSUS (M21 candidate)

These unsigned x64 candidates target Windows 11 with an explicitly selected Ubuntu 24.04 WSL2 environment, and native Ubuntu 24.04. Debian, other Ubuntu releases, ARM and macOS are not verified package targets. See the M21 report for actual evidence and outstanding release gates.

## Windows

Run the assisted Setup executable. Choose the application folder, then a **separate desktop data folder** for settings and caches; both can be on D:. The saved data location survives application uninstall. Setup does not move existing data. An unavailable saved drive stops setup/launch instead of creating a replacement profile on C:.

Windows installation installs the desktop only. The bundled `resources/setup` folder contains the backend package, optional helper staging package, checksums, license notices and this guide. The administrator must provision an explicitly selected Ubuntu 24.04 **WSL2** environment with a normal non-root user. Choose a D:-backed WSL virtual disk through your organization's approved procedure if C: is constrained. abysSUS never installs/unregisters/reconfigures a distribution, changes shared WSL swap or selects a service distribution.

Copy the backend .deb into the selected Ubuntu environment. Through its normal OS package tools, install `abyssus-backend_0.1.0_amd64.deb` and its listed dependencies. A typical administrator command inside that explicitly selected environment is `sudo apt install ./abyssus-backend_0.1.0_amd64.deb`. No password is sent through abysSUS. APT may need network access; bundled Node/backend do not make the prerequisite installation fully offline. Corporate proxy/repository configuration remains an administrator task.

Open abysSUS, select that distribution, and choose a persistent Linux profile path such as `/home/your-name/.local/share/abyssus`. Select **Initialize a new profile** only for a new profile; select **Open existing profile** after an upgrade. Import/create projects on the Linux filesystem. Mounted Windows drive projects are unsupported. A D:-backed WSL disk keeps the profile, projects and dependency caches on D:. Set the provider endpoint/key in Settings; secrets remain in the Linux profile.

## Native Ubuntu 24.04

Install the matching backend package first, then the desktop .deb through Ubuntu's package installer. Node/npm development tools are not required for launch. The backend runs as your normal user. Bubblewrap, user namespaces and the documented toolchain must work; failed checks never fall back to a host shell. This installer does not relax AppArmor/kernel policy. An administrator must evaluate any required namespace policy for this machine.

## Optional system installs

Install the separate matching helper-staging .deb only if system-wide package installation is desired. It supplies root-owned code, not enabled authority. systemd, pkexec and a working graphical OS authorization agent are required. In desktop setup, explicitly enable the helper and authenticate through the OS. Decline/deny/cancel leaves it disabled; ordinary safe work remains usable. Missing agents are not silently installed. Work-network STARK testing is separate from helper setup.

## Manual upgrades, repair and removal

Close abysSUS normally and wait for tool/backend cleanup. Disable helper authority through the trusted setup **before** changing Linux packages, including repairing a damaged client descriptor through the existing helper UI. Do not delete its credentials/code manually.

Windows upgrades use **close → uninstall application files → install the new version**. In-place replacement and forced termination are disabled. The separate desktop data folder and saved location remain. Reinstall uses that location; it does not merge or migrate data. Use matching desktop/backend packages; do not mix candidate releases.

Linux package maintenance refuses active leases or enabled helper authority. An interrupted dpkg transaction leaves a maintenance marker and launch disabled. An administrator must finish configuring/reinstalling the same reviewed package set; inspect package state before retrying. Do not delete the marker to bypass verification. Application removal preserves profiles, keys, chats, projects, caches and helper audit. No distro unregister, broad cleanup or automatic removal of OS packages occurs.

All artifacts are **unsigned** unless the release explicitly records verified signatures. Compare SHA256SUMS obtained from the reviewed GitHub release; a checksum beside an untrusted download is not publisher authentication. SmartScreen/workplace policy may block unsigned installers. No signing credentials are assumed.

## Acceptance still required

Native folder-picker/UNC/cancel, graphical OS-auth allow/deny/cancel, actual close during a privileged install, clean Windows/WSL deployment, complete clean-machine workflow and live work-network STARK require separately recorded acceptance. Automated fixture providers and CI policy rules do not establish these results.
