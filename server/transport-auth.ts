import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
const equal=(a:string,b:string)=>Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
/** Per-process capabilities. Never serialize this object or expose it in DTOs. */
export class TransportAuth {
  readonly token:string;
  readonly pairingCode=randomBytes(24).toString('hex');
  private readonly expires=Date.now()+5*60_000;
  private attempts=0;
  private paired=false;
  private sessions=new Set<string>();
  private readonly cookieName:string;
  constructor(instanceId:string,token=randomBytes(32).toString('hex'),private readonly browserPairing=true) {
    if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid transport capability');
    this.token=token;this.cookieName=`abyssus_${instanceId.replaceAll('-','')}`;
  }
  register(app:FastifyInstance) {
    app.addHook('onRequest',async(request,reply)=>{
      const pathname=request.routeOptions.url??request.url.split('?')[0];
      if(!pathname.startsWith('/api')&&!request.url.startsWith('/api'))return;
      if(request.url.split('?')[0].includes('%'))return reply.code(400).send({error:'Encoded route paths are not accepted'});
      // These lifecycle endpoints independently require M16 HMAC proofs.
      if(['/api/backend/readiness','/api/backend/shutdown','/api/auth/pair'].includes(pathname))return;
      const authorization=request.headers.authorization;
      const bearer=typeof authorization==='string'&&authorization.startsWith('Bearer ')?authorization.slice(7):'';
      const cookies=(request.headers.cookie??'').split(';').map(p=>p.trim().split('='));
      const values=cookies.filter(([name])=>name===this.cookieName).map(([,value])=>value);
      const cookie=values.length===1&&this.sessions.has(values[0]);
      if(!equal(bearer,this.token)&&!cookie)return reply.code(401).send({error:'Pair this browser with the running backend.'});
      reply.header('Cache-Control','no-store');
    });
    app.post('/api/auth/pair',async(request,reply)=>{
      const input=z.object({code:z.string().regex(/^[a-f0-9]{48}$/)}).strict().safeParse(request.body);
      // Count malformed attempts too. Never regenerate or automatically reopen pairing.
      if(!this.browserPairing||this.paired||Date.now()>this.expires||++this.attempts>10||!input.success||!equal(input.data.code,this.pairingCode))return reply.code(403).send({error:'Pairing code invalid, expired or used. Restart the browser backend to pair again.'});
      this.paired=true;
      const session=randomBytes(32).toString('hex');this.sessions.add(session);
      return reply.header('Cache-Control','no-store').header('Set-Cookie',`${this.cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/api`).send({ok:true});
    });
    app.addHook('onClose',async()=>{this.sessions.clear();});
  }
}
