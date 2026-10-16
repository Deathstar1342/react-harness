import { connect,isIP } from 'node:net';
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==keys.sort().join('|'))throw new Error();};
try{
 let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>4096)throw new Error();}const value=JSON.parse(raw);
 exact(value,['version','sessionId','nonce','host','port']);
 if(value.version!==1||!Number.isInteger(value.port)||value.port<1024||value.port>65535||!/^[a-f0-9]{64}$/.test(value.nonce)||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.sessionId)||!(value.host==='host.docker.internal'||/^(?:10\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|192\.168\.)[0-9.]+$/.test(value.host)))throw new Error();
 const challenge={version:1,sessionId:value.sessionId,nonce:value.nonce,port:value.port};
 let address;await new Promise((resolve,reject)=>{const socket=connect({host:value.host,port:value.port}),timer=setTimeout(()=>{socket.destroy();reject(new Error());},5000);let response='';
  socket.once('connect',()=>{address=socket.remoteAddress;if(isIP(address)!==4){socket.destroy();reject(new Error());return;}socket.write(JSON.stringify(challenge)+'\n');});socket.on('data',chunk=>{response+=chunk;if(response.length>2048){socket.destroy();reject(new Error());}if(response.endsWith('\n')){try{const proof=JSON.parse(response);exact(proof,['version','sessionId','nonce','port','accepted']);if(proof.accepted!==true||Object.keys(challenge).some(key=>proof[key]!==challenge[key]))throw new Error();clearTimeout(timer);socket.destroy();resolve();}catch(error){reject(error);}}});socket.once('error',reject);socket.once('close',()=>{clearTimeout(timer);reject(new Error());});
 });console.log(JSON.stringify({...challenge,accepted:true,address}));
}catch{console.error('PRIVATE_ROUTE_UNPROVEN');process.exitCode=1;}
