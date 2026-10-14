import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
let text='# Third-party notices\n\nabysSUS candidate redistribution inventory. See each bundled license for terms.\n\n';
for(const base of ['build/app/node_modules','build/desktop-app/node_modules']){
  async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){
    if(!entry.isDirectory())continue;const folder=path.join(dir,entry.name);
    if(entry.name.startsWith('@')){await walk(folder);continue;}
    try{const p=JSON.parse(await readFile(path.join(folder,'package.json'),'utf8'));text+=`\n## ${p.name} ${p.version}\nLicense: ${p.license??'SEE LICENSE FILE'}\n`;
      for(const name of await readdir(folder))if(/^(license|copying|notice)(\.|$)/i.test(name))text+='\n'+await readFile(path.join(folder,name),'utf8')+'\n';
    }catch(error){if(error.code!=='ENOENT'&&error.code!=='EISDIR')throw error;}
  }}try{await walk(path.join(root,base));}catch(error){if(error.code!=='ENOENT')throw error;}
}
try{text+='\n## Node.js bundled runtime\n'+await readFile(root+'/build/runtime/LICENSE','utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
await writeFile(root+`/build/bundled/THIRD-PARTY-NOTICES-${process.platform}.txt`,text);
