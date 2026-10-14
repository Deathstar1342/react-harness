// Read-only diagnosis before Electron can display a modal startup error.
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const executable = path.resolve(process.argv[2]), home = fs.realpathSync.native(process.argv[3]);
Object.defineProperty(process, 'execPath', { value: executable });
const selected = {};
require(path.join(path.dirname(executable), 'resources/app/desktop/bootstrap.cjs')).configure({
  isPackaged: true,
  commandLine: { getSwitchValue: () => home },
  setPath: (key, value) => { selected[key] = value; },
});
assert.equal(selected.userData.toLowerCase(), home.toLowerCase());
console.log('PASS actual installed payload integrity and saved data selection before Electron startup');
