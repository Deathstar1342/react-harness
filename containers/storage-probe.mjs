/** Fixed trusted-image probe. Only /probe/write is writable; no project startup. */
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { lstatSync,readFileSync,readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const script=fileURLToPath(import.meta.url),database='/probe/write/linux.sqlite';
const requireValue=(value)=>{if(!value)throw new Error('STORAGE_PROBE_REFUSED');};
const exact=(value,keys)=>requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('|')===[...keys].sort().join('|'));
try{
  let raw='';for await(const chunk of process.stdin){raw+=chunk;requireValue(raw.length<=8192);}const input=JSON.parse(raw);
  if(process.argv[2]){
    exact(input,['nonce']);requireValue(/^[a-f0-9]{64}$/.test(input.nonce));requireValue(lstatSync(database).isFile());
    const db=new DatabaseSync(database,{timeout:0});
    try{
      if(process.argv[2]==='contend'){
        let denied=false;try{db.exec('BEGIN IMMEDIATE');db.exec('ROLLBACK');}catch(error){if(error.errcode===5)denied=true;else throw error;}
        requireValue(denied);console.log(JSON.stringify({denied:true}));
      }else{
        requireValue(process.argv[2]==='reopen');requireValue(db.prepare('SELECT nonce FROM proof').get()?.nonce===input.nonce);console.log(JSON.stringify({reopened:true}));
      }
    }finally{db.close();}
  }else{
    exact(input,['version','revision','probeId','nonce','launchId','storageId']);requireValue(input.version===1&&input.revision===1&&/^[a-f0-9]{64}$/.test(input.nonce));
    for(const key of ['probeId','launchId','storageId'])requireValue(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input[key]));
    requireValue(process.getuid()>0&&readdirSync('/probe/write').length===0);
    const slots={};for(const name of ['state','config','workspace','control']){
      const info=lstatSync('/probe/'+name,{bigint:true});requireValue(info.isDirectory()&&!info.isSymbolicLink());slots[name]={dev:String(info.dev),ino:String(info.ino)};
      if(name!=='control')requireValue(readFileSync('/probe/'+name+'/.storage-id','utf8')===input.storageId+'\n');
    }
    requireValue(new Set(Object.values(slots).map(v=>v.dev+':'+v.ino)).size===4);
    const run=mode=>{
      const result=spawnSync(process.execPath,[script,mode],{input:JSON.stringify({nonce:input.nonce}),encoding:'utf8',timeout:15000,maxBuffer:8192,cwd:'/tmp',env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp'}});
      requireValue(result.status===0&&!result.error);return JSON.parse(result.stdout);
    };
    const db=new DatabaseSync(database,{timeout:0});
    try{
      requireValue(db.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode==='wal');db.exec('PRAGMA synchronous=FULL; CREATE TABLE proof(nonce TEXT NOT NULL); BEGIN IMMEDIATE');db.prepare('INSERT INTO proof VALUES (?)').run(input.nonce);
      requireValue(run('contend').denied===true);db.exec('COMMIT');requireValue(run('reopen').reopened===true);
    }finally{db.close();}
    console.log(JSON.stringify({...input,slots,sqlite:{wal:true,secondWriterDenied:true,reopened:true}}));
  }
}catch{console.error('STORAGE_PROBE_REFUSED');process.exitCode=1;}
