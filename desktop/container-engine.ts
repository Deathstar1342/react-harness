import { z } from 'zod';
import { boundedProcess } from './process.js';
const contextName=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
const infoSchema=z.object({ID:z.string().min(1).max(256),OSType:z.literal('linux'),Architecture:z.enum(['x86_64','amd64']),DockerRootDir:z.string().min(1).max(4096),SecurityOptions:z.array(z.string()).default([])});
export interface EngineIdentity {context:string;endpoint:string;id:string;dataRoot:string;platform:'linux'|'win32'}
export type EngineQuery=(args:string[])=>Promise<string>;
/** Read-only discovery; this returns identity, never container launch authority. */
export async function detectContainerEngine(platform:NodeJS.Platform,query:EngineQuery):Promise<EngineIdentity> {
  if(platform!=='linux'&&platform!=='win32')throw new Error('The desktop container runtime supports Linux and Windows x64.');
  const context=contextName.parse((await query(['context','show'])).trim());
  const endpoint=(await query(['context','inspect',context,'--format','{{.Endpoints.docker.Host}}'])).trim();
  const local=platform==='linux'?/^unix:\/\/\/[^\x00-\x20]+$/.test(endpoint):/^npipe:\/\/\.\/pipe\/(?:docker_engine|dockerDesktopLinuxEngine)$/.test(endpoint);
  if(!local)throw new Error('Select a local Docker Linux engine. Remote, TCP and SSH contexts are unsupported.');
  const info=infoSchema.parse(JSON.parse(await query(['--context',context,'info','--format','{{json .}}'])));
  if(info.SecurityOptions.some(value=>/rootless|userns/.test(value)))throw new Error('This engine uses an unsupported user mapping. No engine settings were changed.');
  // DockerRootDir is in the Desktop VM, not evidence of its Windows backing disk.
  return {context,endpoint,id:info.ID,dataRoot:info.DockerRootDir,platform};
}
export function engineQuery(cwd:string,env:NodeJS.ProcessEnv=process.env):EngineQuery {
  const clean:NodeJS.ProcessEnv={};
  for(const key of ['PATH','HOME','USERPROFILE','SystemRoot','WINDIR','TEMP','TMP'])if(env[key])clean[key]=env[key];
  for(const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DOCKER_API_VERSION'])if(env[key])throw new Error('Remove inherited Docker connection overrides before opening desktop setup.');
  return args=>boundedProcess(process.platform==='win32'?'docker.exe':'docker',args,{cwd,env:clean,timeout:15000});
}
export function sameEngine(expected:EngineIdentity,actual:EngineIdentity) {
  if(expected.context!==actual.context||expected.endpoint!==actual.endpoint||expected.id!==actual.id||expected.platform!==actual.platform||expected.dataRoot!==actual.dataRoot)throw new Error('Selected engine identity changed. Existing ownership is retained for recovery.');
}
