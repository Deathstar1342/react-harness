// Electron must reach readiness before loading the ESM main module's top-level
// await. This is the production entry, including in installed packages.
const { app, dialog } = require('electron');
function start() {
  try {
    const bootstrap = require('./bootstrap.cjs');
    bootstrap.configure(app);
    if (app.isPackaged) {
      if (!app.requestSingleInstanceLock()) { app.quit(); return; }
      if (!require('./package-lease.node').held) throw new Error('Package maintenance exclusion is unavailable.');
      bootstrap.verifyPackage();
      if (process.platform === 'win32') bootstrap.validateLocation(app.getPath('userData'), require('node:path').dirname(process.execPath));
    }
  } catch (error) { console.error('abysSUS setup needs attention:', error.message); dialog.showErrorBox('abysSUS setup needs attention', error.message); app.exit(1); return; }
  void import('./main.js').catch(error => {
  console.error('abysSUS desktop startup failed:', error instanceof Error ? error.message : 'Unknown error');
  require('electron').app.exit(1);
  });
}
start();
