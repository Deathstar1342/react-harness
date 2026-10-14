const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
let verifiedReceipt;
let verifiedLocation;

function within(a, b) { return a === b || a.startsWith(b + path.win32.sep); }
function validateLocation(value, install, probeWrite = true) {
  if (typeof value !== 'string' || value.length > 240 || !/^[A-Za-z]:\\/.test(value) || /[\x00-\x1f<>"|?*]/.test(value) || value.slice(2).includes(':') || value.split(/[\\/]/).some(p => p === '.' || p === '..' || /[. ]$/.test(p))) throw new Error('Choose an absolute local drive folder without traversal or device paths.');
  const resolved = fs.realpathSync.native(value).replace(/\\$/, '').toLowerCase();
  if (!/^[a-z]:\\/.test(resolved) || resolved.length < 4 || !fs.statSync(value).isDirectory()) throw new Error('The saved desktop data folder is unavailable. Restore its drive or repair the location; no replacement profile was created.');
  const protectedPaths = [install, process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map(p => fs.realpathSync.native(p).replace(/\\$/, '').toLowerCase());
  if (protectedPaths.some(p => within(resolved, p) || within(p, resolved))) throw new Error('Desktop data must be separate from application and Windows installation folders, including linked folders.');
  if (probeWrite) {
    const probe = path.join(value, '.abyssus-write-' + crypto.randomUUID());
    const fd = fs.openSync(probe, 'wx', 0o600); fs.closeSync(fd); fs.unlinkSync(probe);
  }
  return fs.realpathSync.native(value);
}

function parseLocation(bytes) {
  if (bytes.length > 2048) throw new Error('Invalid desktop location file.');
  const unicode=bytes[0]===255&&bytes[1]===254;
  if(unicode&&bytes.length%2!==0)throw new Error('Invalid desktop location encoding.');
  const text=new TextDecoder(unicode?'utf-16le':'utf-8',{fatal:true}).decode(unicode?bytes.subarray(2):bytes);
  const match=text.match(/^\[desktop\]\r?\npath=([^\r\n]+)\r?\n?$/);
  if(!match)throw new Error('Invalid desktop location file. Repair the installation.');
  return match[1];
}
function verifyPackage() {
  const install = path.dirname(process.execPath);
  const receiptFile=path.join(install,'package-integrity.json'),receiptStat=fs.lstatSync(receiptFile);
  if(!receiptStat.isFile()||receiptStat.size>16*1024*1024)throw new Error('Invalid package receipt.');
  const receipt = fs.readFileSync(receiptFile, 'utf8');
  if(verifiedReceipt!==undefined&&receipt!==verifiedReceipt)throw new Error('Installation changed during startup. Close this launch and reopen after package maintenance completes.');
  const integrity = JSON.parse(receipt);
  if (!integrity || typeof integrity !== 'object' || Array.isArray(integrity) || Object.keys(integrity).length > 50000) throw new Error('Invalid package receipt; reinstall the reviewed package.');
  for(const required of ['resources/app/desktop/entry.cjs','resources/app/desktop/main.js','resources/app/desktop/package-lease.node'])if(!integrity[required])throw new Error('Incomplete package receipt.');
  for (const [relative, digest] of Object.entries(integrity)) {
    if (relative.includes('..') || path.isAbsolute(relative) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid package receipt.');
    const payload = path.join(install, relative);
    if (fs.lstatSync(payload).isSymbolicLink() || crypto.createHash('sha256').update(fs.readFileSync(payload)).digest('hex') !== digest) throw new Error('Application files are incomplete or changed. Reinstall the matching reviewed package; saved data is preserved.');
  }
  verifiedReceipt=receipt;
  const file=path.join(install,'desktop-location.ini');
  if(fs.existsSync(file)){const locationStat=fs.lstatSync(file);if(!locationStat.isFile()||locationStat.size>2048)throw new Error('Invalid desktop location file.');}
  const location=fs.existsSync(file)?fs.readFileSync(file).toString('hex'):null;
  if(verifiedLocation!==undefined&&location!==verifiedLocation)throw new Error('Saved desktop location changed during startup; reopen after setup completes.');
  verifiedLocation=location;
}
function configure(app) {
  if (!app.isPackaged) return;
  verifyPackage();
  const install=path.dirname(process.execPath),file=path.join(install,'desktop-location.ini');
  if (process.platform !== 'win32') return;
  let saved;
  if (fs.existsSync(file)) {
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 2048) throw new Error('Invalid desktop location file. Repair the installation.');
    saved = validateLocation(parseLocation(fs.readFileSync(file)), install, false);
  }
  const override = app.commandLine.getSwitchValue('user-data-dir');
  const selected = override ? validateLocation(override, install, false) : saved;
  if (!selected || (saved && selected.toLowerCase() !== saved.toLowerCase())) throw new Error('Choose the desktop data folder in Setup. A launch override may not change the saved profile.');
  app.setPath('userData', selected);
  app.setPath('sessionData', selected);
  app.setPath('cache', selected);
}
module.exports = { configure, validateLocation, parseLocation, verifyPackage };
