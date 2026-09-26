import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, realpath, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import type { Config } from './config.js';
import { publicSettings } from './config.js';
import { Runtime, type RuntimeHooks } from './runtime.js';
import { Store } from './store.js';
import type { ModelProvider, RunEvent, ToolService } from '../shared/types.js';

const executeFile = promisify(execFile);
const approvalMode = z.enum(['autonomous','balanced','review']);
export interface AppOptions { config: Config; provider: ModelProvider; tools: ToolService; hooks: RuntimeHooks; store?: Store; staticRoot?: string }
export async function createApp(options: AppOptions) {
  const {config,provider,tools,hooks} = options;
  const store = options.store ?? new Store(path.join(config.dataDir,'state.sqlite'));
  store.recover();
  const runtime = new Runtime(store,provider,tools,config,hooks);
  const app = Fastify({logger:false,bodyLimit:2*1024*1024});
  const watchers = new Map<string,FSWatcher>();
  const pendingChanges = new Map<string,ReturnType<typeof setTimeout>>();
  const recentWrites = new Map<string,number>();
  const eventStreams = new Set<ServerResponse>();
  store.changes.on('event',(event: RunEvent)=> {
    if (event.type !== 'file_changed') return;
    const data = event.data as {path:string;source:string};
    if (data.source !== 'external') recentWrites.set(`${store.chat(event.chatId).projectId}:${data.path}`,Date.now());
  });
  const watchProject = (projectId: string) => {
    if (watchers.has(projectId)) return;
    const project = store.project(projectId);
    try {
      const watcher = watch(project.path,{recursive:true},(_event,filename)=> {
        const file = filename?.toString().replaceAll('\\','/');
        if (!file || file.split('/').some(part=>part.startsWith('.') || ['node_modules','dist','coverage'].includes(part))) return;
        const key = `${projectId}:${file}`;
        clearTimeout(pendingChanges.get(key));
        pendingChanges.set(key,setTimeout(()=> {
          pendingChanges.delete(key);
          if (Date.now() - (recentWrites.get(key) ?? 0) < 1000) return;
          recentWrites.delete(key);
          runtime.notifyFileChange(projectId,file,'external');
          for (const chat of store.chats(projectId)) store.event(chat.id,'file_changed',{path:file,source:'external'});
        },150));
      });
      watcher.on('error',()=>{watcher.close();watchers.delete(projectId);});
      watchers.set(projectId,watcher);
    } catch { /* File hash checks remain authoritative when watching is unavailable. */ }
  };
  app.addHook('onRequest',async (request,reply)=> {
    if (!request.url.startsWith('/api')) return;
    let hostname: string;
    try { hostname = new URL(`http://${request.headers.host ?? ''}`).hostname; } catch { return reply.code(403).send({error:'Invalid host'}); }
    if (!['localhost','127.0.0.1','[::1]'].includes(hostname)) return reply.code(403).send({error:'Only local access is allowed'});
    const origin = request.headers.origin;
    if (origin) {
      try {
        const url = new URL(origin);
        if (!['http:','https:'].includes(url.protocol) || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || ![String(config.port),'5173'].includes(url.port)) return reply.code(403).send({error:'Cross-origin API access denied'});
      } catch { return reply.code(403).send({error:'Invalid origin'}); }
    }
    if (['POST','PUT','PATCH','DELETE'].includes(request.method) && !request.headers['content-type']?.startsWith('application/json')) return reply.code(415).send({error:'JSON request body required'});
  });
  app.setErrorHandler((error,request,reply)=> {
    if (error instanceof z.ZodError) return reply.code(400).send({error:error.issues.map(issue=>`${issue.path.join('.')}: ${issue.message}`).join('; ')});
    const e = error as Error & {statusCode?:number;code?:string};
    const conflict = /stale|conflict|changed since|dirty|unsaved|version mismatch/i.test(e.message);
    const statusCode = conflict ? 409 : e.statusCode ?? (e.code === 'ENOENT' ? 404 : 400);
    reply.code(statusCode >= 400 && statusCode < 600 ? statusCode : 500).send({error:e.message.replaceAll(config.apiKey || '\u0000','[redacted]')});
  });
  const paramId = (params: unknown) => z.object({id:z.string().min(1)}).parse(params).id;
  app.get('/api/health',async()=>({ok:true}));
  app.get('/api/settings',async()=>publicSettings(config));
  app.get('/api/models',async()=>({models:await provider.models()}));
  app.get('/api/projects',async()=>store.projects());
  app.post('/api/projects',async(request,reply)=> {
    const body = z.object({name:z.string().trim().min(1).max(100),path:z.string().trim().min(1).max(4096),mode:z.enum(['create','import'])}).strict().parse(request.body);
    if (!path.isAbsolute(body.path)) throw new Error('Use an absolute project folder path');
    let root = path.resolve(body.path);
    if (root === path.parse(root).root) throw new Error('Choose a project folder, not the filesystem root');
    if (body.mode === 'create') {
      if (existsSync(root) && (await readdir(root)).length) throw new Error('New project folder must be empty; import an existing project instead');
      await mkdir(root,{recursive:true});
      await executeFile('git',['init','--initial-branch=main',root],{timeout:15000,windowsHide:true});
    } else if (!(await stat(root)).isDirectory()) throw new Error('Project path must be a directory');
    root = await realpath(root);
    if (root === path.parse(root).root) throw new Error('Choose a project folder, not the filesystem root');
    const project = store.createProject(body.name,root); watchProject(project.id);
    return reply.code(201).send(project);
  });
  app.get('/api/projects/:id/chats',async request=> {const id = paramId(request.params);store.project(id);return store.chats(id);});
  app.post('/api/projects/:id/chats',async(request,reply)=> {
    const body = z.object({title:z.string().trim().min(1).max(200).optional(),approvalMode:approvalMode.optional()}).strict().parse(request.body);
    const id = paramId(request.params); watchProject(id);
    return reply.code(201).send(store.createChat(id,body.title ?? 'New chat',body.approvalMode ?? config.approvalMode));
  });
  app.get('/api/chats/:id',async request=> {const id = paramId(request.params);watchProject(store.chat(id).projectId);return store.detail(id);});
  app.patch('/api/chats/:id',async request=> {
    const body = z.object({title:z.string().trim().min(1).max(200).optional(),approvalMode:approvalMode.optional()}).strict().parse(request.body);
    return store.updateChat(paramId(request.params),body);
  });
  app.post('/api/chats/:id/messages',async(request,reply)=> {
    const body = z.object({content:z.string().trim().min(1).max(100000)}).strict().parse(request.body);
    if (!config.baseUrl || !config.apiKey) return reply.code(503).send({error:'Configure STARK_BASE_URL and STARK_API_KEY in the backend .env, then restart the backend.'});
    await runtime.submit(paramId(request.params),body.content);
    return reply.code(202).send({accepted:true});
  });
  app.post('/api/chats/:id/control',async request=> {const {action} = z.object({action:z.enum(['pause','resume','interrupt'])}).strict().parse(request.body);await runtime.control(paramId(request.params),action);return {ok:true};});
  app.post('/api/approvals/:id',async request=> {const {decision} = z.object({decision:z.enum(['approve','deny'])}).strict().parse(request.body);await runtime.decide(paramId(request.params),decision);return {ok:true};});
  app.get('/api/projects/:id/files',async request=> {const {path:relative} = z.object({path:z.string().optional()}).parse(request.query);return tools.list(store.project(paramId(request.params)).path,relative);});
  app.get('/api/projects/:id/file',async request=> {const {path:relative} = z.object({path:z.string().min(1)}).parse(request.query);return tools.read(store.project(paramId(request.params)).path,relative);});
  app.put('/api/projects/:id/file',async request=> {
    const body = z.object({path:z.string().min(1),content:z.string().max(1024*1024),baseHash:z.string().nullable(),owner:z.string().min(1).max(200)}).strict().parse(request.body);
    const project = store.project(paramId(request.params));
    const saved = await tools.save(project.path,body.path,body.content,body.baseHash,body.owner);
    runtime.notifyFileChange(project.id,body.path,'editor');
    for (const chat of store.chats(project.id)) store.event(chat.id,'file_changed',{path:body.path,source:'editor'});
    return saved;
  });
  app.post('/api/projects/:id/editor',async request=> {
    const body = z.object({path:z.string().min(1),owner:z.string().min(1).max(200),dirty:z.boolean()}).strict().parse(request.body);
    tools.setDirty(store.project(paramId(request.params)).path,body.path,body.owner,body.dirty); return {ok:true};
  });
  app.get('/api/chats/:id/events',async(request,reply)=> {
    const id = paramId(request.params); store.chat(id);
    const query = z.object({after:z.coerce.number().int().nonnegative().optional()}).parse(request.query);
    const headerId = Number(request.headers['last-event-id']);
    let cursor = Number.isSafeInteger(headerId) && headerId >= 0 ? headerId : query.after ?? 0;
    reply.hijack();
    eventStreams.add(reply.raw);
    reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
    const send = (event: RunEvent) => {
      if (event.id <= cursor) return;
      cursor = event.id;
      if (!reply.raw.destroyed) reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    };
    // Register and replay synchronously; database operations cannot interleave here.
    store.changes.on(id,send);
    let batch = store.events(id,cursor);
    while (batch.length) { for (const event of batch) send(event); if (batch.length < 2000) break; batch = store.events(id,cursor); }
    reply.raw.write(': connected\n\n');
    const heartbeat = setInterval(()=>{if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n');},15000);
    const cleanup = () => {clearInterval(heartbeat);store.changes.off(id,send);eventStreams.delete(reply.raw);};
    reply.raw.on('close',cleanup);
  });
  const staticRoot = options.staticRoot ?? path.resolve('dist/client');
  if (existsSync(staticRoot)) {
    await app.register(staticFiles,{root:staticRoot,prefix:'/',index:'index.html'});
    app.setNotFoundHandler((request,reply)=>request.url.startsWith('/api') ? reply.code(404).send({error:'API route not found'}) : reply.sendFile('index.html'));
  }
  app.addHook('preClose',async()=>{for(const stream of eventStreams) stream.end();});
  app.addHook('onClose',async()=> {for (const watcher of watchers.values()) watcher.close();for (const timer of pendingChanges.values()) clearTimeout(timer);await runtime.close();await tools.dispose();if (!options.store) store.close();});
  return {app,store,runtime};
}
