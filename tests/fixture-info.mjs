// CI-only private fixture handoff. Never expose the destination until all bytes are closed.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export async function publishFixtureInfo(destination, value, io=fs) {
 const temporary=path.join(path.dirname(destination),'.'+path.basename(destination)+'.'+randomUUID()+'.tmp');
 let handle,created=false;
 try {
  handle=await io.open(temporary,'wx',0o600);created=true;
  await handle.writeFile(JSON.stringify(value));await handle.sync();await handle.close();handle=undefined;
  await io.rename(temporary,destination);created=false;
 } finally {
  if(handle)await handle.close();
  if(created)await io.unlink(temporary);
 }
}
