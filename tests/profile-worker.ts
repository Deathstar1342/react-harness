import { ProfileOwnership } from '../server/profile.js';
import { startBackend } from '../server/bootstrap.js';

try {
  const [mode,argument]=process.argv.slice(2);
  if(mode==='lock') {
    const owner=new ProfileOwnership(argument!);
    process.send?.({ready:true});
    process.on('message',()=>{owner.close();process.exit(0);});
  } else {
    const backend=await startBackend(JSON.parse(argument!));
    process.send?.({ready:true,address:backend.address});
    process.on('message',()=>{void backend.close().then(()=>process.exit(0));});
  }
} catch(error) {process.send?.({error:(error as Error).message});process.exitCode=1;process.disconnect?.();}
