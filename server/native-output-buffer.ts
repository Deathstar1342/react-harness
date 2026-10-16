import {nativeStorageActive} from './native-storage.js';
/** Bound private-state RPC frequency; display text never gains action authority. */
export function nativeOutputBuffer(emit:(text:string)=>void){
 if(!nativeStorageActive())return {write:emit,flush:()=>{}};
 let pending='',last=performance.now();
 const flush=()=>{if(!pending)return;const text=pending;pending='';last=performance.now();emit(text);};
 return {write:(text:string)=>{pending+=text;if(Buffer.byteLength(pending)>=16384||performance.now()-last>=100)flush();},flush};
}
