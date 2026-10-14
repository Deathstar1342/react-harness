import { afterEach,describe,it,expect,vi } from 'vitest';
import Fastify from 'fastify';
import { TransportAuth } from '../server/transport-auth.js';
afterEach(()=>vi.restoreAllMocks());
async function fixture() {const app=Fastify(),auth=new TransportAuth('test');auth.register(app);app.get('/api/data',()=>({ok:true}));app.get('/api/events',()=>({events:true}));return {app,auth};}
describe('instance API and SSE authentication',()=>{
  it('requires capability or paired cookie on every API including events',async()=>{
    const {app,auth}=await fixture();try{for(const url of ['/api/data','/api/events']) {
      expect((await app.inject(url)).statusCode).toBe(401);
      expect((await app.inject({url,headers:{authorization:'Bearer '+auth.token}})).statusCode).toBe(200);
      expect((await app.inject({url,headers:{authorization:'Bearer '+auth.token.slice(1)}})).statusCode).toBe(401);
    }}finally{await app.close();}
  });
  it('pairs once with HttpOnly instance-bound cookie and rejects replay/duplicate cookies',async()=>{
    const {app,auth}=await fixture(),other=await fixture();try{
      const result=await app.inject({method:'POST',url:'/api/auth/pair',payload:{code:auth.pairingCode}});expect(result.statusCode).toBe(200);
      const header=String(result.headers['set-cookie']);expect(header).toContain('HttpOnly');expect(header).toContain('SameSite=Strict');
      const cookie=header.split(';')[0];expect((await app.inject({url:'/api/data',headers:{cookie}})).statusCode).toBe(200);
      expect((await other.app.inject({url:'/api/data',headers:{cookie}})).statusCode).toBe(401);
      expect((await app.inject({url:'/api/data',headers:{cookie:cookie+'; '+cookie}})).statusCode).toBe(401);
      expect((await app.inject({method:'POST',url:'/api/auth/pair',payload:{code:auth.pairingCode}})).statusCode).toBe(403);
      expect(result.body).not.toContain(auth.token);
    }finally{await app.close();await other.app.close();}
  });
  it('expires pairing and bounds malformed attempts',async()=>{
    const {app,auth}=await fixture();try{for(let i=0;i<10;i++)await app.inject({method:'POST',url:'/api/auth/pair',payload:{code:'bad'}});
      expect((await app.inject({method:'POST',url:'/api/auth/pair',payload:{code:auth.pairingCode}})).statusCode).toBe(403);
    }finally{await app.close();}
    const next=await fixture();try{const future=Date.now()+300001;vi.spyOn(Date,'now').mockReturnValue(future);expect((await next.app.inject({method:'POST',url:'/api/auth/pair',payload:{code:next.auth.pairingCode}})).statusCode).toBe(403);}finally{vi.restoreAllMocks();await next.app.close();}
  });
});
