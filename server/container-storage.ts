import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { regularFile } from './profile.js';
import { containerPaths } from './container-contract.js';

export const storageReceiptSchema=z.object({version:z.literal(1),storageId:z.uuid(),profileId:z.uuid(),kind:z.literal('local-bind')}).strict();
function directory(directory:string) {
  const stat=lstatSync(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(directory)!==directory || process.platform!=='win32' && (stat.uid!==process.getuid!() || (stat.mode&0o077)!==0))throw new Error('Container storage directory identity or private ownership failed');
}
function read(filename:string) {
  regularFile(filename);
  const stat=lstatSync(filename);
  if(stat.size>4096 || process.platform!=='win32' && (stat.uid!==process.getuid!() || (stat.mode&0o077)!==0))throw new Error('Container storage metadata is not private or is too large');
  return readFileSync(filename,'utf8');
}
/** Read-only preflight: do not create anything before validating established mounts. */
export function verifyContainerStorage(storageId:string,home:string=containerPaths.home,workspace:string=containerPaths.workspace) {
  z.uuid().parse(storageId);
  const config=path.join(home,'profile','config');
  for(const dir of [home,path.join(home,'profile'),config,path.join(home,'profile','state'),workspace])directory(dir);
  const receipt=storageReceiptSchema.parse(JSON.parse(read(path.join(home,'container-storage.json'))));
  if(receipt.storageId!==storageId)throw new Error('Selected container storage identity changed');
  for(const dir of [home,config,workspace])if(read(path.join(dir,'.storage-id'))!==`${storageId}\n`)throw new Error('Container storage mount missing or replaced');
  const marker=JSON.parse(read(path.join(home,'profile','profile.json'))) as {id?:string;protocol?:string};
  if(marker.id!==receipt.profileId || marker.protocol!=='native-tools-v1')throw new Error('Container native profile identity changed');
  for(const name of ['migration.json','profile/state/state.sqlite','profile/config/.env']) {
    // Provider configuration is bounded separately by ProviderSettingsFile.
    const file=path.join(home,name);regularFile(file);
    if(realpathSync(file)!==file)throw new Error('Container storage file must not traverse links');
  }
  const database=new DatabaseSync(path.join(home,'profile','state','state.sqlite'),{readOnly:true});
  try {
    const get=(key:string)=>database.prepare('SELECT data FROM state WHERE key=?').get(key)?.data;
    if(get('prototype:protocol')!==JSON.stringify('native-tools-v1')||get('container:storage-id')!==JSON.stringify(storageId)||get('container:profile-id')!==JSON.stringify(receipt.profileId))throw new Error('Established container database identity changed');
  } finally {database.close();}
  return receipt;
}
