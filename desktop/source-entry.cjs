// Source-only entry. All mutable Electron files stay beside the selected payload.
const {app}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../..');
for(const [key,name] of [['userData','desktop-data'],['sessionData','desktop-data'],['cache','desktop-data'],['logs','logs'],['crashDumps','crashes'],['temp','temp']]){
  const directory=path.join(root,name),info=fs.lstatSync(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||fs.realpathSync.native(directory)!==directory)throw new Error('Selected source runtime storage is missing or linked; restore it before starting.');
  app.setPath(key,directory);
}
require('./entry.cjs');
