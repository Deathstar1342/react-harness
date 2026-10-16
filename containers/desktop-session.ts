import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
const hex=z.string().regex(/^[a-f0-9]{64}$/);
export const desktopLaunchSchema=z.object({version:z.literal(1),storageId:z.uuid(),launchId:z.uuid(),key:hex,token:hex}).strict();
/** Private mounted host capability, never selected by renderer or profile configuration. */
export function readDesktopLaunch(storageId:string,file='/run/abyssus-broker/desktop-launch.json') {
  if(realpathSync(path.dirname(file))!==path.dirname(file))throw new Error('Unsafe desktop capability directory');
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||stat.size>2048||process.platform!=='win32'&&(stat.uid!==process.getuid!()||(stat.mode&0o077)!==0))throw new Error('Unsafe desktop capability');
    const value=desktopLaunchSchema.parse(JSON.parse(readFileSync(fd,'utf8')));
    if(value.storageId!==storageId)throw new Error('Desktop storage capability changed');
    return value;
  }finally{closeSync(fd);}
}
