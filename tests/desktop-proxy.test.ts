import { it,expect } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { desktopResponse } from '../desktop/proxy.js';
it('strips renderer credentials, streams SSE incrementally, cancels and refuses redirects',async()=>{
  let received:Record<string,unknown>={},closed=false;
  const server=createServer((req,res)=>{
    received=req.headers;
    if(req.url==='/api/redirect'){res.writeHead(302,{location:'/api/data'});res.end();return;}
    if(req.url==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: ready\ndata: first\n\n');req.once('close',()=>{closed=true;});return;}
    res.writeHead(200,{'content-type':'application/json'});res.end('{}');
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  const target={address:`http://127.0.0.1:${(server.address() as {port:number}).port}`,token:'trusted'};
  try {
    const result=await desktopResponse(new Request('abyssus://app/api/data',{headers:{authorization:'Bearer attacker',cookie:'secret=value','x-forwarded-host':'evil',origin:'https://evil'}}),'/unused',target);
    expect(result.status).toBe(200);expect(received.authorization).toBe('Bearer trusted');expect(received.cookie).toBeUndefined();expect(received.origin).toBeUndefined();expect(received['x-forwarded-host']).toBeUndefined();
    await expect(desktopResponse(new Request('abyssus://app/api/redirect'),'/unused',target)).rejects.toThrow();
    const controller=new AbortController(),stream=await desktopResponse(new Request('abyssus://app/api/events',{signal:controller.signal}),'/unused',target);
    const reader=stream.body!.getReader();expect(new TextDecoder().decode((await reader.read()).value)).toContain('first');
    await reader.cancel();controller.abort();
    await new Promise(r=>setTimeout(r,50));expect(closed).toBe(true);
    for(const url of ['abyssus://app/api/backend/shutdown','abyssus://app/api/auth/pair'])expect((await desktopResponse(new Request(url),'/unused',target)).status).toBe(403);
    expect((await desktopResponse(new Request('abyssus://app/api/data',{method:'POST',body:'x'.repeat(2*1024*1024+1),headers:{'content-type':'application/json'}}),'/unused',target)).status).toBe(413);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
