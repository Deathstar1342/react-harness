import { readFileSync } from 'node:fs';
import { signBackendRequest, verifyBackendProof } from '../server/lifecycle.js';
import { verifyContainerStorage } from '../server/container-storage.js';
try {
  const receipt=verifyContainerStorage(process.env.HARNESS_STORAGE_ID ?? '');
  const descriptor=JSON.parse(readFileSync('/abyssus/backend.json','utf8'));
  if(descriptor.identity?.profileId!==receipt.profileId||descriptor.identity?.state!=='ready')throw new Error();
  if(process.argv[2]==='request')process.stdout.write(JSON.stringify(signBackendRequest(descriptor.key,'readiness',descriptor.identity.instanceId)));
  else if(process.argv[2]==='verify') {
    let input='';for await(const chunk of process.stdin){input+=String(chunk);if(input.length>8192)throw new Error();}
    const [request,proof]=JSON.parse(`[${input.trim().split('\n').join(',')}]`);
    if(!verifyBackendProof(descriptor.key,'readiness',request,proof)||proof.identity.profileId!==receipt.profileId||proof.identity.state!=='ready')throw new Error();
  } else throw new Error();
} catch {console.error('Host endpoint identity verification failed');process.exitCode=1;}
