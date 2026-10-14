import { setTimeout as delay } from 'node:timers/promises';
import { signBackendRequest, verifyBackendProof } from '../server/lifecycle.js';
import type { BackendIdentity, BackendProof } from '../shared/types.js';
import { loopbackAddress } from './backend-wire.js';

/** Only the read-only readiness challenge may retry, at the same private URL. */
export async function waitForReadiness(address:string,key:string,identity:BackendIdentity,owned:AbortSignal) {
  const url=loopbackAddress(address)+'/api/backend/readiness';
  const deadline=new AbortController();
  const timer=setTimeout(()=>deadline.abort(new Error('Backend readiness connectivity timed out; the owned process remains tracked.')),10000);
  const signal=AbortSignal.any([owned,deadline.signal]);
  try {
    for(;;){
      signal.throwIfAborted();
      const request=signBackendRequest(key,'readiness',identity.instanceId);
      let response:Response;
      try {
        response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),redirect:'error',signal});
      } catch(error) {
        signal.throwIfAborted();
        // HTTP, redirects, parsing and proof failures are outside this retry.
        const code=(error as {cause?:{code?:string}})?.cause?.code;
        if(!(error instanceof TypeError)||!code||!['ECONNREFUSED','ECONNRESET','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'].includes(code))throw new Error('Backend readiness transport failed');
        await delay(250,undefined,{signal});
        continue;
      }
      if(!response.ok)throw new Error('Backend readiness HTTP response was not successful');
      const proof:BackendProof=await response.json();
      signal.throwIfAborted();
      if(!verifyBackendProof(key,'readiness',request,proof)||proof.identity.profileId!==identity.profileId||proof.identity.pid!==identity.pid||proof.identity.platform!==identity.platform||proof.identity.state!=='ready')throw new Error('Backend readiness identity mismatch');
      return;
    }
  } catch(error) {signal.throwIfAborted();throw error;}
  finally{clearTimeout(timer);}
}
