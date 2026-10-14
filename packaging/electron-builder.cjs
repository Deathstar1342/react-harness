module.exports = {
  appId: 'com.abyssus.desktop', productName: 'abysSUS', executableName: 'abysSUS',
  electronVersion: '42.11.13', npmRebuild: false, asar: false,
  directories: { app: 'build/desktop-app', output: 'build/release', buildResources: 'packaging' },
  files: ['**/*'],
  extraResources: [{ from: 'build/bundled', to: 'setup' }],
  publish: null,
  afterPack: 'scripts/package-linux-hooks.cjs',
  afterSign: 'scripts/package-windows-hook.cjs',
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: 'client/assets/abyssus-logo.png', signExecutable: false, artifactName: 'abysSUS-${version}-windows-x64-setup.${ext}' },
  nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false, runAfterFinish: false, include: 'packaging/windows.nsh' },
  linux: { target: [{ target: 'deb', arch: ['x64'] }], icon: 'client/assets/abyssus-logo.png', category: 'Development', maintainer: 'abysSUS contributors', artifactName: 'abysSUS-${version}-ubuntu24.04-amd64.${ext}' },
  deb: { depends: ['abyssus-backend (= 0.1.0)', 'libgtk-3-0', 'libnss3', 'libasound2t64', 'libgbm1', 'libxss1', 'libxtst6', 'xdg-utils'], fpm: ['--before-install=packaging/desktop-preinst','--before-remove=packaging/desktop-prerm'], afterInstall: 'packaging/desktop-postinst', afterRemove: 'packaging/desktop-postrm' }
};
