import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { chmod, mkdtemp, rm, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const registryHosts = new Set(['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org']);
// Deliberately conservative global-unicast policy. IPv6 transition, mapped,
// documentation and special-purpose ranges are not download destinations.
export function publicAddress(address: string): boolean {
  if (net.isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a===0 || a===10 || a===127 || a>=224 || a===100 && b>=64 && b<=127 ||
      a===169 && b===254 || a===172 && b>=16 && b<=31 || a===192 && (b===0 || b===168 || b===88 && c===99) ||
      a===198 && (b===18 || b===19 || b===51 && c===100) || a===203 && b===0 && c===113);
  }
  if (net.isIP(address) !== 6 || address.includes('.') || address.includes('%')) return false;
  const words=address.toLowerCase().split(':');
  const first=parseInt(words[0],16), second=parseInt(words[1] || '0',16);
  // Conservative currently allocated global prefixes; unknown allocations fail
  // closed until this policy is deliberately updated.
  return (first===0x2001 && second>=0x200 && second!==0xdb8) || first===0x2003 ||
    [0x2400,0x2600,0x2800,0x2a00,0x2c00].includes(first&0xfff0);
}
export function registryAuthority(authority: string): string {
  const match=/^([a-z0-9.-]+):443$/.exec(authority);
  if (!match || match[0]!==authority || !registryHosts.has(match[1])) throw new Error('Only registry.npmjs.org, pypi.org and files.pythonhosted.org on port 443 are allowed');
  return match[1];
}
export async function resolveRegistry(host: string, resolver: typeof lookup = lookup): Promise<string> {
  if (!registryHosts.has(host)) throw new Error('Registry is not allowed');
  const addresses=await resolver(host,{all:true,verbatim:true});
  if (!addresses.length || addresses.some(item=>!publicAddress(item.address))) throw new Error('Registry DNS returned a non-public address');
  return (addresses.find(item=>item.family===4) ?? addresses[0]).address;
}

/** Destination capability only: TLS/content stays end-to-end, with no host DNS
 * forwarding, redirects, credentials or general-purpose forwarding authority. */
export async function startRegistryProxy() {
  const directory=await mkdtemp(path.join(tmpdir(),'abyssus-registry-'));
  await chmod(directory,0o700);
  const directoryIdentity=await lstat(directory);
  const socket=path.join(directory,'proxy.sock');
  const connections=new Set<net.Socket>();
  let closed=false;
  const server=http.createServer({maxHeaderSize:4096,requestTimeout:10_000,headersTimeout:10_000},(_req,res)=>{
    res.writeHead(403,{'Connection':'close'});res.end('HTTPS registry CONNECT only');
  });
  server.maxConnections=16;
  server.on('connection',connection=>{
    if(closed){connection.destroy();return;}
    connections.add(connection);connection.setTimeout(30_000,()=>connection.destroy());
    connection.on('error',()=>{});connection.once('close',()=>connections.delete(connection));
  });
  server.on('clientError',(_error,connection)=>connection.destroy());
  server.on('upgrade',(_request,connection)=>connection.destroy());
  server.on('connect',async(req,raw,head)=>{
    const client=raw as net.Socket;
    try {
      const hosts=req.rawHeaders.filter((_,index)=>index%2===0 && req.rawHeaders[index].toLowerCase()==='host');
      if(closed || head.length || req.rawHeaders.length>40 || hosts.length!==1 || req.headers.host!==req.url || req.headers['content-length']!==undefined || req.headers['transfer-encoding']!==undefined || req.headers.upgrade!==undefined || req.headers.authorization!==undefined || req.headers['proxy-authorization']!==undefined) throw new Error('Invalid CONNECT');
      const host=registryAuthority(req.url ?? '');
      const ip=await Promise.race([resolveRegistry(host),new Promise<never>((_,reject)=>{const t=setTimeout(()=>reject(new Error('DNS timeout')),5000);t.unref();})]);
      if(closed || client.destroyed)return;
      // Literal address pins the checked answer: net.connect does not resolve it again.
      const upstream=net.connect({host:ip,port:443});connections.add(upstream);
      const lifetime=setTimeout(()=>{client.destroy();upstream.destroy();},300_000);lifetime.unref();
      let bytes=0;
      const bound=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>128*1024*1024){client.destroy();upstream.destroy();}};
      client.on('data',bound);upstream.on('data',bound);
      upstream.setTimeout(30_000,()=>upstream.destroy());
      upstream.once('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');client.pipe(upstream);upstream.pipe(client);});
      upstream.on('error',()=>client.destroy());
      upstream.once('close',()=>{clearTimeout(lifetime);connections.delete(upstream);client.destroy();});
      client.once('close',()=>upstream.destroy());
    } catch { if(!client.destroyed)client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
  });
  const verify=async()=>{
    const dir=await lstat(directory),entry=await lstat(socket);
    if(!dir.isDirectory() || dir.dev!==directoryIdentity.dev || dir.ino!==directoryIdentity.ino || dir.uid!==process.getuid?.() || (dir.mode&0o777)!==0o700 || !entry.isSocket() || entry.uid!==dir.uid || (entry.mode&0o777)!==0o600 || (await readdir(directory)).join()!=='proxy.sock')throw new Error('Private registry bridge identity changed');
  };
  try { await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socket,()=>{server.removeListener('error',reject);resolve();});});await chmod(socket,0o600);await verify(); }
  catch(error){server.close();await rm(directory,{recursive:true,force:true});throw error;}
  let closePromise:Promise<void>|undefined;
  return {directory,socket,verify,close:()=>closePromise ??= (async()=>{
    closed=true;for(const connection of connections)connection.destroy();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    const remaining=await lstat(directory).catch(()=>undefined);
    if(remaining && (remaining.dev!==directoryIdentity.dev || remaining.ino!==directoryIdentity.ino))throw new Error('Registry bridge directory changed during cleanup');
    await rm(directory,{recursive:true,force:true});
  })()};
}
