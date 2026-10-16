// Test-only remote peer in another thread: the controller main thread blocks.
import {parentPort,workerData} from 'node:worker_threads';
import {createServer} from 'node:net';
import {createHmac,randomBytes} from 'node:crypto';
const d=workerData.descriptor,control=new Int32Array(workerData.control);
const canonical=value=>JSON.stringify(sort(value));function sort(v){return v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;}
const mac=value=>createHmac('sha256',d.key).update(canonical(value)).digest('hex');
const server=createServer(socket=>{let raw='';socket.on('data',chunk=>{raw+=chunk;if(!raw.endsWith('\n'))return;const request=JSON.parse(raw),count=Atomics.add(control,0,1)+1;const fail=Atomics.load(control,1),delay=Atomics.load(control,2);
 const send=()=>{if(socket.destroyed)return;const now=Date.now();const result={storageId:d.storageId,launchId:d.launchId,gateId:randomBytes(32).toString('hex'),issuedAt:now,expiresAt:now+10000};const value={protocol:d.protocol,sessionId:d.sessionId,nonce:request.nonce,ok:true,result};if(fail===count)value.result.launchId='wrong-launch';socket.end(canonical({...value,mac:mac(value)})+'\n');};if(delay)setTimeout(send,delay);else send();});});
server.listen(0,'127.0.0.1',()=>parentPort.postMessage({port:server.address().port}));
