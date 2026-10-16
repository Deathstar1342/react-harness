/** Fixed private-state observation worker. No configurable opcode or path. */
import {parentPort,workerData} from 'node:worker_threads';
import {connect} from 'node:net';
import {randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
const {descriptor:d,buffer}=workerData,words=new Int32Array(buffer);
const canonical=value=>JSON.stringify(sort(value)).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
function sort(value){if(Array.isArray(value))return value.map(sort);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sort(value[k])]));return value;}
const signature=value=>createHmac('sha256',d.key).update(canonical(value)).digest('hex');
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))throw Error('shape');}
function poison(){Atomics.store(words,3,1);Atomics.store(words,2,-1);Atomics.store(words,1,Atomics.load(words,0));Atomics.notify(words,1);}
let busy=false;
async function check(generation){
 if(busy||!Number.isSafeInteger(generation)||generation<=0||generation!==Atomics.load(words,0)||Atomics.load(words,3))return poison();busy=true;
 try{
  const nonce=randomBytes(32).toString('hex'),issued=Date.now();
  const request={protocol:'abyssus-worker-v1',sessionId:d.sessionId,nonce,expiresAt:issued+3000,op:'storage_check',body:{}};
  const result=await new Promise((resolve,reject)=>{
   const socket=connect({host:d.host,port:d.port});let bytes=Buffer.alloc(0),done=false;
   const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
   const timer=setTimeout(()=>finish(Error('deadline')),2500);
   socket.once('connect',()=>socket.write(canonical({...request,mac:signature(request)})+'\n'));
   socket.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);if(bytes.length>4096)return finish(Error('limit'));if(!chunk.includes(10))return;
    try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!text.endsWith('\n')||text.slice(0,-1).includes('\n'))throw Error('wire');const value=JSON.parse(text);if(text.slice(0,-1)!==canonical(value))throw Error('noncanonical');exact(value,['protocol','sessionId','nonce','ok','result','mac']);const {mac,...signed}=value;
     if(value.protocol!==request.protocol||value.sessionId!==d.sessionId||value.nonce!==nonce||value.ok!==true||typeof mac!=='string'||!/^[a-f0-9]{64}$/.test(mac)||!timingSafeEqual(Buffer.from(mac,'hex'),Buffer.from(signature(signed),'hex')))throw Error('auth');
     const gate=value.result;exact(gate,['storageId','launchId','gateId','issuedAt','expiresAt']);const now=Date.now();
     if(gate.storageId!==d.storageId||gate.launchId!==d.launchId||typeof gate.gateId!=='string'||!/^[a-f0-9]{64}$/.test(gate.gateId)||!Number.isSafeInteger(gate.issuedAt)||!Number.isSafeInteger(gate.expiresAt)||gate.issuedAt>now||gate.expiresAt<now||gate.expiresAt<=gate.issuedAt||gate.expiresAt-gate.issuedAt>10000||now<issued)throw Error('binding');finish(undefined,true);
    }catch{finish(Error('reply'));}});
   socket.once('error',()=>finish(Error('connection')));socket.once('close',()=>finish(Error('closed')));
  });
  if(result!==true||generation!==Atomics.load(words,0)||Atomics.load(words,3))throw Error('late');
  Atomics.store(words,2,1);Atomics.store(words,1,generation);Atomics.notify(words,1);
 }catch{poison();}finally{busy=false;}
}
parentPort.on('message',value=>{if(!value||Object.keys(value).length!==1)return poison();void check(value.generation);});
Atomics.store(words,2,1);Atomics.store(words,1,0);Atomics.notify(words,1);
