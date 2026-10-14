import { realpath, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { assetPath, contentSecurityPolicy, isDesktopURL } from './policy.js';
export interface BackendTarget {address:string;token:string;sessionId?:string}
const csp={'Content-Security-Policy':contentSecurityPolicy,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'};
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.ttf':'font/ttf','.json':'application/json'};
export async function desktopResponse(request:Request,root:string,target?:BackendTarget):Promise<Response> {
  if(!isDesktopURL(request.url))return new Response(null,{status:403});
  const url=new URL(request.url);
  if(url.pathname.startsWith('/api/')) {
    if(!target)return Response.json({error:'Backend unavailable. Open desktop setup to recover.'},{status:503});
    if(!['GET','POST','PUT','PATCH','DELETE'].includes(request.method)||url.pathname.startsWith('/api/backend/')||url.pathname.startsWith('/api/auth/')||/%(?:2f|5c|00)/i.test(url.pathname)||url.pathname.includes('\\'))return new Response(null,{status:403});
    let body:ArrayBuffer|undefined;
    if(request.method!=='GET') {
      if(!request.headers.get('content-type')?.startsWith('application/json'))return new Response(null,{status:415});
      // Stream bounded input; do not allocate an unbounded arrayBuffer first.
      const reader=request.body?.getReader();const parts:Uint8Array[]=[];let bytes=0;
      if(reader)try{while(true){const item=await reader.read();if(item.done)break;bytes+=item.value.length;if(bytes>2*1024*1024){await reader.cancel();return new Response(null,{status:413});}parts.push(item.value);}}finally{reader?.releaseLock();}
      const joined=new Uint8Array(bytes);let at=0;for(const part of parts){joined.set(part,at);at+=part.length;}body=joined.buffer;
    }
    const headers:Record<string,string>={authorization:`Bearer ${target.token}`};
    if(body)headers['content-type']='application/json';
    const last=request.headers.get('last-event-id');if(last&&/^\d{1,16}$/.test(last))headers['last-event-id']=last;
    const abort=new AbortController();const cancel=()=>abort.abort();request.signal.addEventListener('abort',cancel,{once:true});
    const response=await fetch(target.address+url.pathname+url.search,{method:request.method,headers,body,redirect:'error',signal:abort.signal});
    const type=response.headers.get('content-type')??'application/json';
    if(!type.startsWith('application/json')&&!type.startsWith('text/event-stream')){await response.body?.cancel();return new Response(null,{status:502});}
    const reader=response.body?.getReader();
    const cleanup=()=>request.signal.removeEventListener('abort',cancel);
    const stream=reader?new ReadableStream<Uint8Array>({
      async pull(controller){try{const item=await reader.read();if(item.done){cleanup();controller.close();}else controller.enqueue(item.value);}catch(error){cleanup();controller.error(error);}},
      cancel(){abort.abort();cleanup();void reader.cancel().catch(()=>{});},
    }):null;
    // Explicit stream ownership closes the upstream request on renderer cancellation;
    // never wait on a still-open SSE source's cancellation promise.
    return new Response(stream,{status:response.status,headers:{...csp,'Content-Type':type}});
  }
  if(request.method!=='GET')return new Response(null,{status:405});
  try {
    const file=assetPath(root,request.url),canonical=await realpath(file),base=await realpath(root);
    if(!canonical.startsWith(base+path.sep)||!(await stat(canonical)).isFile())return new Response(null,{status:403});
    return new Response(await readFile(canonical),{headers:{...csp,'Content-Type':mime[path.extname(canonical)]??'application/octet-stream'}});
  } catch{return new Response(null,{status:404});}
}
