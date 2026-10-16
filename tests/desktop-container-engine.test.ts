import { expect,it,vi } from 'vitest';
import { detectContainerEngine,engineQuery,sameEngine } from '../desktop/container-engine.js';
const info={ID:'engine-identity',OSType:'linux',Architecture:'x86_64',DockerRootDir:'/var/lib/docker',SecurityOptions:['name=seccomp,profile=builtin']};
function query(endpoint:string,extra:object={}){return vi.fn(async(args:string[])=>args[0]==='context'&&args[1]==='show'?'desktop-linux\n':args[0]==='context'?endpoint:JSON.stringify({...info,...extra}));}
it('accepts explicit local transports without claiming a Windows backing disk',async()=>{
  expect(await detectContainerEngine('linux',query('unix:///var/run/docker.sock'))).toMatchObject({platform:'linux',id:info.ID});
  const windows=await detectContainerEngine('win32',query('npipe://./pipe/dockerDesktopLinuxEngine'));
  expect(windows).toMatchObject({platform:'win32',dataRoot:'/var/lib/docker'});
  expect(windows).not.toHaveProperty('windowsBackingPath');
});
it.each(['tcp://127.0.0.1:2375','ssh://localhost','npipe://server/pipe/docker_engine','unix:///var/run/docker.sock','npipe://./pipe/arbitrary'])('refuses Windows endpoint %s before engine query',async endpoint=>{
  const run=query(endpoint);await expect(detectContainerEngine('win32',run)).rejects.toThrow();expect(run).toHaveBeenCalledTimes(2);
});
it.each([{OSType:'windows'},{Architecture:'aarch64'},{SecurityOptions:['name=rootless']},{SecurityOptions:['name=userns']},{ID:''}])('refuses incompatible or unidentifiable engines',async invalid=>{
  await expect(detectContainerEngine('linux',query('unix:///var/run/docker.sock',invalid))).rejects.toThrow();
});
it('rejects inherited endpoint/config overrides without spawning',()=>{
  for(const name of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DOCKER_API_VERSION'])expect(()=>engineQuery('/unused',{[name]:'override'})).toThrow(/overrides/);
});
it('pins engine identity across recovery',async()=>{
  const engine=await detectContainerEngine('linux',query('unix:///var/run/docker.sock'));
  sameEngine(engine,{...engine});
  for(const key of ['context','endpoint','id','dataRoot'] as const)expect(()=>sameEngine(engine,{...engine,[key]:'changed'})).toThrow(/identity changed/);
});
