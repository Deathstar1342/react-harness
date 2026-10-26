import type {BrowserProbeStep} from '../shared/browser-preview.js';

/** Fixed trusted calibration code. No project bytes or caller scripts enter this template. */
export function probeDocument(step:BrowserProbeStep,origin:string,sentinel:string){
  const data={...step,origin,sentinel};
  const script=String.raw`
(async()=>{
 const input=__INPUT__,result={kind:'preview-capability',probeId:input.id,documentId:input.documentId,stage:input.stage,nonce:input.nonce,settled:true,peerOpened:false,peerDelivered:false,error:false};
 const deadline=(work,ms)=>Promise.race([work,new Promise((_,reject)=>setTimeout(()=>reject(new Error('capability deadline')),ms))]);
 const a=new RTCPeerConnection({iceServers:[]}),b=new RTCPeerConnection({iceServers:[]});
 try{
  await deadline(fetch(input.sentinel+'/get/'+input.nonce,{credentials:'omit'}).catch(()=>{}),2000);
  await deadline(new Promise(resolve=>{const image=new Image;image.onload=()=>resolve();image.onerror=()=>resolve();image.src=input.sentinel+'/image/'+input.nonce;}),2000);
  await deadline(new Promise(resolve=>{try{const socket=new WebSocket(input.sentinel.replace('http:','ws:')+'/ws/'+input.nonce);socket.onerror=()=>{socket.close();resolve()};socket.onopen=()=>{socket.close();resolve()};}catch{resolve();}}),2000);
  await deadline(fetch(input.origin+'/redirect/'+input.stage,{credentials:'omit'}).catch(()=>{}),2000);
  let remote=false;const pendingA=[],pendingB=[];const channel=a.createDataChannel('bounded-preview-proof');
  a.onicecandidate=event=>{if(event.candidate){if(remote)Promise.resolve(b.addIceCandidate(event.candidate)).catch(()=>{});else pendingB.push(event.candidate)}};
  b.onicecandidate=event=>{if(event.candidate){if(remote)Promise.resolve(a.addIceCandidate(event.candidate)).catch(()=>{});else pendingA.push(event.candidate)}};
  b.ondatachannel=event=>{event.channel.onmessage=message=>{if(message.data==='fixed-preview-proof')result.peerDelivered=true}};
  channel.onopen=()=>{result.peerOpened=true;channel.send('fixed-preview-proof')};
  await deadline((async()=>{await a.setLocalDescription(await a.createOffer());await b.setRemoteDescription(a.localDescription);await b.setLocalDescription(await b.createAnswer());await a.setRemoteDescription(b.localDescription);remote=true;await Promise.allSettled([...pendingA.map(candidate=>a.addIceCandidate(candidate)),...pendingB.map(candidate=>b.addIceCandidate(candidate))]);})(),3000);
  const end=Date.now()+4500;while(!result.peerDelivered&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,50));
 }catch{result.error=true;}finally{a.close();b.close();}
 parent.postMessage(result,'*');
 if(!result.error)setTimeout(()=>{location.href=input.sentinel+'/navigation/'+input.nonce;},0);
})();`;
  const html='<!doctype html><meta charset="utf-8"><title>Checking preview isolation</title><p>Checking browser network isolation…</p><script>'+script.replace('__INPUT__',JSON.stringify(data))+'</script>';
  if(Buffer.byteLength(html)>16384)throw new Error('Trusted capability document limit');return html;
}
