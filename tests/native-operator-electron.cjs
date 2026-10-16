// Disposable main-process lifetime fixture. No renderer, Docker or application data.
const {app}=require('electron');
const {spawn}=require('node:child_process');
const {readFileSync}=require('node:fs');
// Fixture bootstrap contains only synthetic binding and fixture paths, no capability.
const launch=JSON.parse(readFileSync(process.argv[2],'utf8'));
app.setPath('userData',launch.userData);
app.whenReady().then(()=>{
 const env={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
 const child=spawn(launch.python,['-I','-B',launch.fixture,'host'],{env,cwd:launch.userData,windowsHide:true,detached:true,stdio:['pipe','pipe','pipe']});
 child.stdin.end(JSON.stringify({storage:launch.storage,binding:launch.binding})+'\n');
 let raw='';child.stdout.on('data',chunk=>{raw+=chunk;if(raw.endsWith('\n'))process.stdout.write(raw);});
 child.stderr.on('data',()=>{});child.on('error',()=>process.exit(2));
});
