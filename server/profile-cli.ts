import path from 'node:path';
import { prepareProfile } from './profile.js';

const [action,source,...extra]=process.argv.slice(2);
if(extra.length || action!=='init' && action!=='migrate' || action==='init' && source || action==='migrate' && (!source || !path.isAbsolute(source))) {
  console.error('Use npm run profile:init or npm run profile:migrate -- /absolute/legacy/root');
  process.exitCode=1;
} else {
  try {
    const profile=await prepareProfile({env:{...process.env,...(action==='init'?{HARNESS_INIT:'1'}:{HARNESS_LEGACY_ROOT:source})}});
    profile.ownership.close();
    console.log(`Profile configuration: ${profile.paths.configFile}`);
    console.log('Keep this file private. Start the backend normally after configuring it.');
  } catch(error) {console.error((error as Error).message);process.exitCode=1;}
}
