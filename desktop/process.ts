import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
/** Fixed executable/argv are chosen by trusted main. Never exposed as IPC. */
export function boundedProcess(file:string,args:string[],options:{input?:string;env?:NodeJS.ProcessEnv;timeout?:number;cwd?:string}={}):Promise<string> {
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{cwd:options.cwd??'/',env:options.env,windowsHide:true,stdio:'pipe'});
    let output='',size=0,failed=false;
    const fail=()=>{failed=true;child.kill();};
    const timer=setTimeout(fail,options.timeout??15000);
    child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>256*1024)fail();else output+=chunk.toString();});
    // stderr may include paths/configuration. Never project it to the renderer/log.
    child.stderr.on('data',()=>{});
    child.once('error',()=>{clearTimeout(timer);reject(new Error('Required executable is unavailable'));});
    child.once('close',code=>{clearTimeout(timer);code===0&&!failed?resolve(output):reject(new Error('Prerequisite command failed or timed out'));});
    child.stdin.end(options.input);
  });
}
export function firstLine(child:ChildProcessWithoutNullStreams,timeout=30000):Promise<unknown> {
  return new Promise((resolve,reject)=>{
    let data='';
    const finish=(error?:Error,value?:unknown)=>{clearTimeout(timer);child.stdout.off('data',read);child.off('exit',exit);child.off('error',exit);error?reject(error):resolve(value);};
    const exit=()=>finish(new Error('Backend exited before authenticated readiness. Check selected profile and prerequisites.'));
    const timer=setTimeout(()=>finish(new Error('Backend readiness timed out; the owned process remains tracked.')),timeout);
    const read=(chunk:Buffer)=>{
      data+=chunk.toString();if(Buffer.byteLength(data)>65536)return finish(new Error('Invalid backend startup response'));
      const end=data.indexOf('\n');if(end<0)return;
      try{finish(undefined,JSON.parse(data.slice(0,end)));}catch{finish(new Error('Invalid backend startup response'));}
    };
    child.stdout.on('data',read);child.once('exit',exit);child.once('error',exit);
  });
}
