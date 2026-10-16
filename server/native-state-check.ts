import { Worker } from 'node:worker_threads';
export interface NativeObservation {protocol:'abyssus-worker-v1';sessionId:string;key:string;storageId:string;launchId:string;phase:'initialize'|'controller';transport:'tcp';host:string;port:number}
export class NativeStateCheck {
 private readonly buffer=new SharedArrayBuffer(16);
 private readonly words=new Int32Array(this.buffer);
 private readonly worker:Worker;
 private generation=0;private failed=false;private closed=false;
 checks=0;elapsedMs=0;
 constructor(descriptor:NativeObservation,private readonly onPoison:()=>void){
  Atomics.store(this.words,1,-1);
  this.worker=new Worker(new URL('./native-storage-check-worker.mjs',import.meta.url),{workerData:{descriptor,buffer:this.buffer},env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',NODE_ENV:'production'},execArgv:[]});
  this.worker.on('error',()=>this.poison());this.worker.on('exit',()=>{if(!this.closed)this.poison();});this.worker.unref();
  if(Atomics.wait(this.words,1,-1,3000)==='timed-out'||Atomics.load(this.words,1)!==0||Atomics.load(this.words,3))this.refuse();
 }
 poison(){if(this.failed)return;this.failed=true;Atomics.store(this.words,3,1);this.onPoison();}
 private refuse():never{this.poison();throw new Error('Native private-state observation failed; explicit recovery required');}
 assertHealthy(){if(this.failed||this.closed||Atomics.load(this.words,3))this.refuse();}
 check(){
  this.assertHealthy();if(this.generation>=0x7ffffffe)this.refuse();const generation=++this.generation,started=performance.now();this.checks++;
  Atomics.store(this.words,0,generation);Atomics.store(this.words,2,0);this.worker.postMessage({generation});
  const deadline=started+3000;
  while(Atomics.load(this.words,1)!==generation&&!Atomics.load(this.words,3)){
   const observed=Atomics.load(this.words,1);if(observed===generation)break;const remaining=deadline-performance.now();if(remaining<=0)this.refuse();Atomics.wait(this.words,1,observed,remaining);
  }
  this.elapsedMs+=performance.now()-started;
  if(Atomics.load(this.words,3)||Atomics.load(this.words,0)!==generation||Atomics.load(this.words,2)!==1)this.refuse();
 }
 close(){this.closed=true;Atomics.store(this.words,3,1);void this.worker.terminate();}
}
