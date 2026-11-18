import { globSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, rmdirSync } from 'node:fs';
import path from 'node:path';

const [root, command, ...args]=process.argv.slice(2);
const cwd=process.cwd();
const relative=path.relative(root,cwd);
try {
  if (path.isAbsolute(relative) || relative==='..' || relative.startsWith('..'+path.sep) || path.relative(root,realpathSync(root))!=='' || path.relative(cwd,realpathSync(cwd))!=='') throw new Error('Invalid workspace working directory.');
  const flags=new Set(), operands=[];
  let options=true;
  for (const arg of args) {
    if(options&&arg==='--'){options=false;continue;}
    if(options&&arg.startsWith('--')) {flags.add(arg.slice(2));continue;}
    if(options&&arg.startsWith('-')&&arg!=='-'){for(const flag of arg.slice(1))flags.add(flag);continue;}
    operands.push(arg);
  }
  const target=input=>{
    if(!input || /[\0-\x1f\x7f:]/.test(input) || /^[\\/]/.test(input))throw new Error('Use a workspace-relative path.');
    let current=cwd;
    for(const part of input.split(/[\\/]+/)) {
      if(!part||part==='.')continue;
      if(part==='..'||/[. ]$/.test(part)||/^(?:\.git(?:$|\.)|\.env|\.ssh$|\.aws$|\.azure$|\.docker$|\.kube$|\.config$|\.gnupg$|\.npmrc$|\.netrc$|\.pypirc$|\.gitconfig$|credentials(?:$|\.)|secrets?(?:$|\.)|id_(?:rsa|dsa|ecdsa|ed25519)(?:$|\.))/i.test(part)||/\.(?:pem|key|p12|pfx|keystore)$/i.test(part))throw new Error('Path leaves the workspace or names protected data.');
      current=path.join(current,part);
      try {
        const info=lstatSync(current);
        if(info.isSymbolicLink()||info.isFile()&&info.nlink>1||!info.isFile()&&!info.isDirectory())throw new Error('Linked or special workspace path.');
      } catch(error){if(error.code!=='ENOENT')throw error;}
    }
    return current;
  };
  const requireFlags=allowed=>{
    if([...flags].some(flag=>!allowed.includes(flag)))throw new Error('Unsupported command option.');
  };
  const scan=(relative,budget,depth=0)=>{
    if(depth>64||--budget.remaining<0)throw new Error('Recursive removal exceeds its path limit.');
    const file=target(relative);
    try {
      if(lstatSync(file).isDirectory())for(const entry of readdirSync(file))scan(path.join(relative,entry),budget,depth+1);
    } catch(error){if(error.code!=='ENOENT')throw error;}
  };
  const expanded=input=>{
    target(input);
    if(!/[*?\[]/.test(input))return [input];
    const entries=globSync(input.replaceAll('\\','/'),{cwd});
    if(entries.length>1000)throw new Error('File pattern exceeds the 1000-path limit.');
    return entries;
  };
  if(command==='pwd'){
    requireFlags([]);
    if(operands.length)throw new Error('pwd takes no path arguments.');
    console.log(cwd);
  } else if(['ls','dir','get-childitem'].includes(command)){
    requireFlags(['a','A','l','h','all','almost-all']);
    const names=operands.length?operands.flatMap(expanded):['.'];
    for(const name of names){
      const filename=target(name),info=lstatSync(filename);
      if(!info.isDirectory()){console.log(name);continue;}
      const entries=readdirSync(filename,{withFileTypes:true}).filter(entry=>!entry.name.startsWith('.')||flags.has('a')||flags.has('A')||flags.has('all')||flags.has('almost-all'));
      // No recursive walk and no follow of links. Output is limited by the parent.
      for(const entry of entries)console.log(entry.name+(entry.isDirectory()?'/':''));
    }
  } else if(['mkdir','md'].includes(command)) {
    requireFlags(['p','parents']);
    if(!operands.length||operands.some(name=>/[*?\[]/.test(name)))throw new Error('mkdir needs one or more literal workspace directories.');
    const destinations=operands.map(target);
    for(const destination of destinations)mkdirSync(destination,{recursive:flags.has('p')||flags.has('parents')});
  } else {
    requireFlags(['r','R','f','recursive','force']);
    if(!operands.length)throw new Error('Give explicit workspace paths to remove.');
    const names=operands.flatMap(expanded);
    const destinations=names.map(target);
    if(destinations.some(file=>path.relative(root,file)===''||path.relative(cwd,file)===''))throw new Error('Cannot remove the workspace or working directory.');
    const recursive=flags.has('r')||flags.has('R')||flags.has('recursive');
    if(recursive){const budget={remaining:20000};for(const name of names)scan(name,budget);}
    for(const filename of destinations) {
      if(['rmdir','rd'].includes(command)&&!recursive)rmdirSync(filename);
      else rmSync(filename,{recursive,force:flags.has('f')||flags.has('force')});
    }
  }
} catch(error) {
  console.error(error instanceof Error?error.message:'Workspace command failed.');
  process.exitCode=1;
}
