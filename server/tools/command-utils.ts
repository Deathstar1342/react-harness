import type { LocalCommands } from './local-commands.js';

export function childEnvironment(source:NodeJS.ProcessEnv=process.env):Record<string,string>{
  const result:Record<string,string>={};
  for(const name of ['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TMPDIR','TMP','TEMP','SystemRoot','WINDIR','COMSPEC','PATHEXT']){
    if(source[name]!==undefined)result[name]=source[name]!;
  }
  return {...result,TERM:'dumb',NO_COLOR:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0'};
}
export interface CommandResult {
  uncertain?:boolean;status?:'not_started';output:string;exitCode?:number;cancelled?:boolean;timedOut?:boolean;
  truncated?:boolean;error?:string;backgroundPids?:number[];shellReset?:boolean;
}
export interface CommandOptions {maxOutputBytes:number;maxQueue:number;maxSessions:number;defaultTimeoutMs:number;maxTimeoutMs:number}
type GitRunner=LocalCommands['git'];
export async function gitCommand(root:string,args:string[],maxBytes:number,signal:AbortSignal|undefined,run:GitRunner):Promise<CommandResult>{
  if(signal?.aborted)return {output:'',cancelled:true};
  const overrides:string[]=[];
  if(args[0]!=='config'){
    const config=await gitCommand(root,['config','--null','--name-only','--get-regexp','^filter\\..*\\.(clean|smudge|process|required)$'],maxBytes,signal,run);
    if(config.error||config.cancelled||config.timedOut||(config.exitCode!==0&&config.exitCode!==1))return {output:'',error:'Cannot safely inspect Git filter configuration.'};
    for(const name of new Set(config.output.split('\0').filter(Boolean).map(name=>name.replace(/\.(clean|smudge|process|required)$/,'')))){
      for(const operation of ['clean','smudge','process'])overrides.push('-c',name+'.'+operation+'=');
      overrides.push('-c',name+'.required=false');
    }
  }
  const argv=['--no-optional-locks','--literal-pathspecs','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c',process.platform==='win32'?'core.hooksPath=NUL':'core.hooksPath=/dev/null',...overrides,...args];
  return run(root,process.platform==='win32'?'git.exe':'git',argv,maxBytes,signal);
}
