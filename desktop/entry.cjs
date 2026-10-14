// Electron must reach readiness before loading the ESM main module's top-level
// await. This is the production entry, including in installed packages.
const { app, dialog } = require('electron');
try { require('./bootstrap.cjs').configure(app); }
catch (error) { dialog.showErrorBox('abysSUS setup needs attention', error.message); app.exit(1); }
void import('./main.js').catch(error => {
  console.error('abysSUS desktop startup failed:', error instanceof Error ? error.message : 'Unknown error');
  require('electron').app.exit(1);
});
