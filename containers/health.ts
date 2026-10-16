import { readFileSync } from 'node:fs';
import { signBackendRequest, verifyBackendProof } from '../server/lifecycle.js';
import { verifyContainerStorage } from '../server/container-storage.js';

try {
  const receipt=verifyContainerStorage(process.env.HARNESS_STORAGE_ID ?? '');
  const descriptor=JSON.parse(readFileSync('/abyssus/backend.json','utf8'));
  if(descriptor.identity?.profileId!==receipt.profileId || descriptor.identity?.state!=='ready')throw new Error();
  const request=signBackendRequest(descriptor.key,'readiness',descriptor.identity.instanceId);
  // Ignore descriptor.address: only this fixed private listener may prove readiness.
  const response=await fetch('http://127.0.0.1:3000/api/backend/readiness',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(3000),redirect:'error'});
  const proof=await response.json();
  if(!response.ok||!verifyBackendProof(descriptor.key,'readiness',request,proof)||proof.identity.profileId!==receipt.profileId||proof.identity.state!=='ready')throw new Error();
} catch {console.error('Authenticated controller readiness unavailable');process.exitCode=1;}
