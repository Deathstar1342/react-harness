import { readdir, readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
export async function manifest(root) {
  const files={};
  async function walk(dir){for(const name of (await readdir(dir)).sort()){
    const file=path.join(dir,name),relative=path.relative(root,file).replaceAll('\\','/'),st=await lstat(file);
    if(st.isDirectory())await walk(file);
    else if(st.isFile()) {
      if(/(^|\/)(\.env(?:\..*)?|.*\.(?:sqlite|db|key|pem))$/.test(relative))throw new Error('Forbidden runtime data in release staging');
      files[relative]=createHash('sha256').update(await readFile(file)).digest('hex');
    }
  }}await walk(root);return files;
}
if(process.argv[1]&&realpathSync(process.argv[1])===import.meta.filename){const dir=path.resolve(process.argv[2]);await writeFile(path.join(dir,'SHA256SUMS'),Object.entries(await manifest(dir)).filter(([name])=>name!=='SHA256SUMS').map(([name,hash])=>`${hash}  ${name}\n`).join(''));}
