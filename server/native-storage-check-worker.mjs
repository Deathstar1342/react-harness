/** Fixed private-state observation worker. Only fixed root/relative private metadata targets; no content or effect API. */
import {parentPort,workerData} from 'node:worker_threads';
import {connect} from 'node:net';
import {randomBytes,createHash,createHmac,timingSafeEqual} from 'node:crypto';
const {descriptor:d,buffer}=workerData,words=new Int32Array(buffer);
const canonical=value=>JSON.stringify(sort(value)).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
function sort(value){if(Array.isArray(value))return value.map(sort);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sort(value[k])]));return value;}
const signature=value=>createHmac('sha256',d.key).update(canonical(value)).digest('hex');
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))throw Error('shape');}
function poison(){Atomics.store(words,3,1);Atomics.store(words,2,-1);Atomics.store(words,1,Atomics.load(words,0));Atomics.notify(words,1);}
let busy=false;
async function check(generation,targets){
 if(busy||!Number.isSafeInteger(generation)||generation<=0||generation!==Atomics.load(words,0)||Atomics.load(words,3))return poison();busy=true;
 try{
  const nonce=randomBytes(32).toString('hex'),issued=Date.now();
  if(targets){
   if(!Array.isArray(targets)||targets.length<1||targets.length>8)throw Error('targets');const seen=new Set();
   for(const target of targets){
    exact(target,['root','relative','kind','mode']);const value=target.relative;
    if(!['state','config','control'].includes(target.root)||!['file','directory','sqlite'].includes(target.kind)||!['existing','create'].includes(target.mode)||typeof value!=='string'||Buffer.byteLength(value)>1024||/[\uD800-\uDFFF]/u.test(value)||value.split('/').length>64)throw Error('target');
    if(!value&&!(target.kind==='directory'&&target.mode==='existing')||target.kind==='sqlite'&&!value.endsWith('.sqlite'))throw Error('target class');
    for(const part of value?value.split('/'):[])if(!part||part==='.'||part==='..'||part.length>240||/[\\:\x00-\x1f<>"|?*]/.test(part)||/[. ]$/.test(part)||/^(?:con|conin\$|conout\$|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\..*)?$/i.test(part))throw Error('target path');
    const key=target.root+':'+value.toLowerCase();if(seen.has(key))throw Error('duplicate');seen.add(key);
   }
  }
  const request={protocol:'abyssus-worker-v1',sessionId:d.sessionId,nonce,expiresAt:issued+3000,op:targets?'storage_targets':'storage_check',body:targets?{targets}:{}};
  const targetDigest=targets?createHash('sha256').update(canonical({targets,phase:d.phase,storageId:d.storageId,launchId:d.launchId,sessionId:d.sessionId})).digest('hex'):undefined;
  const result=await new Promise((resolve,reject)=>{
   const socket=connect({host:d.host,port:d.port});let bytes=Buffer.alloc(0),done=false;
   const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
   const timer=setTimeout(()=>finish(Error('deadline')),2500);
   socket.once('connect',()=>socket.write(canonical({...request,mac:signature(request)})+'\n'));
   socket.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);if(bytes.length>4096)return finish(Error('limit'));if(!chunk.includes(10))return;
    try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!text.endsWith('\n')||text.slice(0,-1).includes('\n'))throw Error('wire');const value=JSON.parse(text);if(text.slice(0,-1)!==canonical(value))throw Error('noncanonical');exact(value,['protocol','sessionId','nonce','ok','result','mac']);const {mac,...signed}=value;
     if(value.protocol!==request.protocol||value.sessionId!==d.sessionId||value.nonce!==nonce||value.ok!==true||typeof mac!=='string'||!/^[a-f0-9]{64}$/.test(mac)||!timingSafeEqual(Buffer.from(mac,'hex'),Buffer.from(signature(signed),'hex')))throw Error('auth');
     const gate=value.result;exact(gate,['storageId','launchId','gateId','issuedAt','expiresAt',...(targets?['targetsDigest']:[])]);if(targets&&gate.targetsDigest!==targetDigest)throw Error('target binding');const now=Date.now();
     if(gate.storageId!==d.storageId||gate.launchId!==d.launchId||typeof gate.gateId!=='string'||!/^[a-f0-9]{64}$/.test(gate.gateId)||!Number.isSafeInteger(gate.issuedAt)||!Number.isSafeInteger(gate.expiresAt)||gate.issuedAt>now||gate.expiresAt<now||gate.expiresAt<=gate.issuedAt||gate.expiresAt-gate.issuedAt>10000||now<issued)throw Error('binding');finish(undefined,true);
    }catch{finish(Error('reply'));}});
   socket.once('error',()=>finish(Error('connection')));socket.once('close',()=>finish(Error('closed')));
  });
  if(result!==true||generation!==Atomics.load(words,0)||Atomics.load(words,3))throw Error('late');
  Atomics.store(words,2,1);Atomics.store(words,1,generation);Atomics.notify(words,1);
 }catch{poison();}finally{busy=false;}
}
parentPort.on('message',value=>{try{exact(value,Object.hasOwn(value,'targets')?['generation','targets']:['generation']);void check(value.generation,value.targets);}catch{poison();}});
Atomics.store(words,2,1);Atomics.store(words,1,0);Atomics.notify(words,1);
