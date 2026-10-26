import {TaskQueue,queueStartInput,queueEditInput} from './task-queue.js';
import {parseNativeJSON} from './native-json.js';
import {inspectorView} from './inspector.js';
import {BrowserPreviews} from './browser-previews.js';
import {browserProbeResult} from '../shared/browser-preview.js';
import {registerNativeStorageScope} from './native-storage.js';
import {ProjectTransfers,transferCode} from './project-transfers.js';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, realpath, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import type { Config } from './config.js';
import { publicSettings } from './config.js';
import { Runtime, type RuntimeHooks } from './runtime.js';
import {SkillWrites} from './skill-writes.js';
import {skillIdentity,skillDraftInput,skillSelectionInput,skillRevision,draftFromContent} from './skills.js';
import {skillName} from './skill-files.js';
import { goalInput, goalOf, goalRevisionInput } from './goals.js';
import { Store } from './store.js';
import { WorkspaceLocations } from './workspace.js';
import { Settings } from './settings.js';
import { ProviderSettings, type ProviderSettingsFile } from './provider-settings.js';
import { ConnectionDiagnostics } from './diagnostics.js';
import { Changes } from './changes.js';
import {Checkpoints,captureCheckpointInput,previewCheckpointInput,restoreCheckpointInput} from './checkpoints.js';
import { Removal } from './removal.js';
import { createManagedHooks } from './context.js';
import type { ModelProvider, RunEvent, ToolService } from '../shared/types.js';
import { installationRoot, applicationHome } from './locations.js';
import { LinuxSandbox } from './tools/sandbox.js';
import type { BackendLifecycle } from './lifecycle.js';
import { InstallService, type InstallHelper } from './installs.js';
import type { TransportAuth } from './transport-auth.js';
import {ContainerInstallClient} from './container-installs.js';
import {previewProject} from './preview-state.js';
import {Previews,previewPath} from './previews.js';
import {recoveryView} from './recovery.js';
import {workerAvailable} from './worker-client.js';
import { containerExecutionUnavailable } from './container-contract.js';

const approvalMode = z.enum(['autonomous','balanced','review']);
export interface AppOptions { browserPreview?:'direct'|'source-fixed-3000'; config: Config; provider: ModelProvider; tools: ToolService; hooks: RuntimeHooks; store?: Store; staticRoot?: string; providerSettingsFile?: ProviderSettingsFile; lifecycle?:{identity:BackendLifecycle;close:()=>Promise<void>}; packageHelper?:()=>Promise<InstallHelper>; transportAuth?:TransportAuth }
export async function createApp(options: AppOptions) {
  const {config,provider,tools,hooks} = options;
  const store = options.store ?? new Store(path.join(config.dataDir,'state.sqlite'));
  const sandbox=new LinuxSandbox();
  const sandboxPolicy={executionMode:config.executionMode,home:config.appHome ?? applicationHome(),protectedPaths:[config.dataDir,...Object.values(config.promptFiles).filter((p):p is string=>!!p),...(options.providerSettingsFile?[options.providerSettingsFile.filename]:[])],projects:()=>store.projects().map(p=>p.path)};
  sandbox.configure(sandboxPolicy);tools.configureSandbox?.(sandboxPolicy);
  // Reject stale or tampered registrations before recovery/watchers/runtime can access them.
  if(config.executionMode==='container')for(const project of store.projects())sandbox.validateRoot(project.path);
  store.initializeModels(config.models);
  store.recover();
  const managedComplete=hooks.complete ?? createManagedHooks(provider,store,config).complete!;
  const installs=new InstallService(store,config.models.critic,managedComplete,options.packageHelper,Date.now,20000,config.executionMode==='container'?{connect:(id,target)=>ContainerInstallClient.connect(store.project(id).path,target),available:workerAvailable}:undefined);
  const runtime = new Runtime(store,provider,tools,config,hooks,installs);
  const previews=new Previews(store,runtime.processes,config.executionMode==='container');
  const skillWrites=new SkillWrites(runtime);
  const changes = new Changes(store,tools,runtime);
  const checkpoints=new Checkpoints(store,runtime);
  const locations = new WorkspaceLocations(store,config.workspaceRoot,root=>sandbox.validateRoot(root),config.executionMode==='container');
  const settings = new Settings(store,config.approvalMode);
  const providerSettings = new ProviderSettings(config,store,options.providerSettingsFile);
  const diagnostics = new ConnectionDiagnostics(config,provider,hooks.complete ?? createManagedHooks(provider,store,config).complete!);
  const app = Fastify({logger:false,bodyLimit:2*1024*1024});
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json',{parseAs:'string'},(request,body,done)=>{try{done(null,request.url.includes('/queue')?parseNativeJSON(String(body),600000):JSON.parse(String(body)));}catch{done(Object.assign(new Error('Invalid or ambiguous JSON request'),{statusCode:400}));}});
  const browserPreviews=new BrowserPreviews(previews,()=>{if(!options.transportAuth?.browserPairingEnabled)return;const address=app.server.address();if(!address||typeof address==='string')return;if(options.browserPreview==='direct'&&address.address==='127.0.0.1')return address.port;if(options.browserPreview==='source-fixed-3000'&&config.executionMode==='container'&&config.host==='0.0.0.0'&&config.port===3000&&address.port===3000)return 3000;});
  browserPreviews.register(app);
  const watchers = new Map<string,FSWatcher>();
  const pendingChanges = new Map<string,ReturnType<typeof setTimeout>>();
  const recentWrites = new Map<string,{hash:string|null;at:number}>();
  const eventStreams = new Set<ServerResponse>();
  const chatStreams = new Map<string,Map<ServerResponse,()=>void>>();
  const removedProjects = new Set<string>();
  const requests = new Map<string,string>();
  const resetting=new Set<string>();
  const removal = new Removal(store,runtime,tools,config,locations,(projectId,chatIds,wholeProject)=>{
    for (const chatId of chatIds) for (const [stream,cleanup] of chatStreams.get(chatId) ?? []) {
      cleanup();
      if (!stream.destroyed) stream.end(`event: chat_removed\ndata: ${JSON.stringify({chatId,projectId,projectRemoved:wholeProject})}\n\n`);
    }
    changes.forget(projectId);
    if (wholeProject) {
      removedProjects.add(projectId);
      watchers.get(projectId)?.close();watchers.delete(projectId);
      for (const [key,timer] of pendingChanges) if (key.startsWith(`${projectId}:`)) { clearTimeout(timer);pendingChanges.delete(key); }
      for (const key of recentWrites.keys()) if (key.startsWith(`${projectId}:`)) recentWrites.delete(key);
    }
  });
  let closing = false;
  store.changes.on('event',(event: RunEvent)=> {
    if (event.type !== 'file_changed') return;
    const data = event.data as {path:string;source:string;hash?:string|null};
    if (data.source !== 'external' && data.hash !== undefined) {
      for(const [key,entry] of recentWrites) if(Date.now()-entry.at>60000) recentWrites.delete(key);
      recentWrites.set(`${store.chat(event.chatId).projectId}:${data.path}`,{hash:data.hash,at:Date.now()});
    }
  });
  const watchProject = (projectId: string) => {
    if (watchers.has(projectId)) return;
    const project = store.project(projectId);
    try {
      const watcher = watch(project.path,{recursive:true},(_event,filename)=> {
        const file = filename?.toString().replaceAll('\\','/');
        if (!file || !file.startsWith('.abyssus/skills/') && file.split('/').some(part=>part.startsWith('.') || ['node_modules','dist','coverage'].includes(part))) return;
        const key = `${projectId}:${file}`;
        clearTimeout(pendingChanges.get(key));
        pendingChanges.set(key,setTimeout(async()=> {
          pendingChanges.delete(key);
          if (closing || removedProjects.has(projectId)) return;
          const ownWrite = recentWrites.get(key);
          if (ownWrite) {
            const current = await tools.read(project.path,file).catch(()=>undefined);
            if (current && current.hash===ownWrite.hash) return;
          }
          if (closing || removedProjects.has(projectId)) return;
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
    // Fastify decodes static segments before routing. Reject encoded path spelling
    // before any raw-prefix policy; query values (including file paths) stay valid.
    if(request.url.split('?')[0].includes('%'))return reply.code(400).send({error:'Encoded route paths are not accepted'});
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
  options.transportAuth?.register(app);
  registerNativeStorageScope(app);
  options.lifecycle?.identity.register(app,options.lifecycle.close);
  const paramId = (params: unknown) => z.object({id:z.string().min(1)}).parse(params).id;
  app.get('/api/chats/:id/inspector',async(request,reply)=>{const query=z.object({cursor:z.string().max(1024).optional()}).strict().parse(request.query);reply.header('Cache-Control','no-store');return inspectorView(store,paramId(request.params),query.cursor);});
  app.get('/api/chats/:id/recovery',async(request,reply)=>{
    z.object({}).strict().parse(request.query);
    reply.header('Cache-Control','no-store');return recoveryView(store,paramId(request.params));
  });
  app.get('/api/chats/:id/skills',async request=>{await runtime.checkSkills(paramId(request.params));return {catalog:await runtime.skills.files(paramId(request.params)).catalog(),selection:runtime.skills.view(paramId(request.params)),drafts:runtime.skills.drafts(paramId(request.params))};});
  app.get('/api/chats/:id/skills/document',async request=>{const input=skillIdentity.parse(request.query);return runtime.skills.files(paramId(request.params)).load(input.scope,input.name);});
  app.post('/api/chats/:id/skills/draft',async request=>store.transaction(()=>runtime.skills.draft(paramId(request.params),skillDraftInput.parse(request.body),'human')));
  app.post('/api/chats/:id/skills/draft-content',async request=>{const input=z.strictObject({name:skillName,content:z.string().max(32000),expectedRevision:z.number().int().nonnegative()}).parse(request.body);return store.transaction(()=>runtime.skills.draft(paramId(request.params),draftFromContent(input.name,input.content,input.expectedRevision),'human'));});
  app.post('/api/chats/:id/skills/invoke',async request=>runtime.selectSkill(paramId(request.params),skillSelectionInput.parse(request.body)));
  app.post('/api/chats/:id/skills/deselect',async request=>{const input=skillIdentity.extend({selectionRevision:z.number().int().nonnegative()}).parse(request.body);return runtime.deselectSkill(paramId(request.params),input.scope,input.name,input.selectionRevision);});
  app.post('/api/chats/:id/skills/save-preview',async request=>{const input=z.strictObject({name:skillName,content:z.string().max(32000),baseHash:skillRevision.nullable(),owner:z.string().min(1).max(200).optional()}).parse(request.body);return skillWrites.preview(paramId(request.params),input.name,input.content,input.baseHash,input.owner);});
  app.post('/api/chats/:id/skills/promote-preview',async request=>{
    if(!options.transportAuth)throw Object.assign(new Error('Personal promotion requires an authenticated backend session.'),{statusCode:403});
    const input=z.strictObject({name:skillName,revision:skillRevision}).parse(request.body);return skillWrites.promotion(paramId(request.params),input.name,input.revision);
  });
  app.post('/api/chats/:id/skills/save',async request=>{const input=z.strictObject({id:z.string().uuid(),destination:z.string().min(1).max(4096)}).parse(request.body);return skillWrites.commit(paramId(request.params),input.id,input.destination,!!options.transportAuth);});
  // Track complete request lifetimes, including awaits before a save or registration.
  app.addHook('preHandler',async request=>{
    const route=request.routeOptions.url ?? '';
    // This synchronous read validates bounded chat/project rows in its snapshot.
    if(route==='/api/chats/:id/recovery'||route==='/api/chats/:id/inspector')return;
    if(route.startsWith('/api/projects/:id/previews')){
      const {id}=z.strictObject({id:z.uuid()}).passthrough().parse(request.params),project=previewProject(store,id);
      if(request.method==='POST')store.assertCheckpointSafe(id);
      if(resetting.has(id))throw Object.assign(new Error('Sandbox reset is pending'),{statusCode:409});
      if(project.removalError&&request.method==='POST')throw Object.assign(new Error('Project removal needs recovery'),{statusCode:409});
      requests.set(request.id,id);return;
    }
    if (request.method==='DELETE' || route.endsWith('/deletion-preview') || route.endsWith('/events')) return;
    if (route==='/api/projects' && request.method==='POST' || route==='/api/workspace' && request.method==='PATCH') { if(resetting.size)throw Object.assign(new Error('Sandbox reset is pending'),{statusCode:409});requests.set(request.id,'*');return; }
    const params=request.params as {id?:string};
    if (!params?.id) return;
    let projectId:string|undefined;
    if (route.startsWith('/api/projects/:id')) projectId=store.project(params.id).id;
    else if (route.startsWith('/api/chats/:id')) projectId=store.chat(params.id).projectId;
    else if (route.startsWith('/api/approvals/:id')) projectId=store.chat(store.getApproval(params.id).chatId).projectId;
    if (projectId) {
      if(['POST','PUT','PATCH'].includes(request.method)&&!route.endsWith('/editor')&&!route.endsWith('/control'))store.assertCheckpointSafe(projectId);
      if(resetting.has(projectId))throw Object.assign(new Error('Sandbox reset is pending'),{statusCode:409});
      if (store.project(projectId).removalError && ['POST','PUT','PATCH'].includes(request.method) && !route.endsWith('/editor') && !route.endsWith('/control') && !route.endsWith('/transfer-release')) throw Object.assign(new Error('Project removal needs recovery before work can resume'),{statusCode:409});
      if(route.includes('/queue'))return;
      if(['POST','PUT','PATCH','DELETE'].includes(request.method))queues.intervention(projectId);
      requests.set(request.id,projectId);
    }
  });
  app.addHook('onResponse',async request=>{requests.delete(request.id);});
  app.addHook('onError',async request=>{requests.delete(request.id);});
  const assertNoRequests=(projectId:string,exceptRequest?:string)=>{
    if ([...requests].some(([requestId,id])=>requestId!==exceptRequest && (id==='*' || id===projectId))) throw Object.assign(new Error('A project request is still pending; wait before removal or reset'),{statusCode:409});
  };
  const queues=new TaskQueue(runtime,()=>settings.get().defaultApprovalMode,projectId=>assertNoRequests(projectId));
  app.get('/api/projects/:id/queue',async(request,reply)=>{const query=z.strictObject({cursor:z.string().max(1024).optional()}).parse(request.query);reply.header('Cache-Control','no-store');return queues.view(paramId(request.params),query.cursor);});
  app.patch('/api/projects/:id/queue',async request=>queues.edit(paramId(request.params),queueEditInput.parse(request.body)));
  app.post('/api/projects/:id/queue/start',async(request,reply)=>{if(!config.baseUrl||!config.apiKey)return reply.code(503).send({error:'Configure the provider before starting the queue.'});return queues.start(paramId(request.params),queueStartInput.parse(request.body));});
  app.post('/api/projects/:id/queue/cancel-active',async request=>queues.cancel(paramId(request.params),z.strictObject({expectedRevision:z.number().int().safe().nonnegative(),taskId:z.uuid(),chatId:z.uuid()}).parse(request.body)));
  app.post('/api/projects/:id/deletion-preview',async request=>{
    z.object({}).strict().parse(request.body);return removal.preview(paramId(request.params));
  });
  app.delete('/api/projects/:id',async request=>{
    const body=z.discriminatedUnion('mode',[
      z.object({mode:z.literal('app-only')}).strict(),
      z.object({mode:z.literal('disk'),canonicalPath:z.string().min(1).max(4096),confirmationToken:z.string().uuid()}).strict(),
    ]).parse(request.body);
    const id=paramId(request.params);assertNoRequests(id);return removal.project(id,body);
  });
  app.delete('/api/chats/:id',async request=>{
    z.object({}).strict().parse(request.body);const id=paramId(request.params);assertNoRequests(store.chat(id).projectId);return removal.chat(id);
  });
  app.get('/api/health',async()=>({ok:true}));
  app.get('/api/settings',async()=>({...publicSettings(config),executionAvailable:config.executionMode==='container'?await workerAvailable():true,approvalMode:settings.get().defaultApprovalMode}));
  app.get('/api/provider-settings',async()=>providerSettings.get());
  app.patch('/api/provider-settings',async request=>providerSettings.update(request.body));
  app.get('/api/preferences',async()=>settings.get());
  app.get('/api/system-installs/settings',async()=>installs.view());
  app.patch('/api/system-installs/settings',async request=>{installs.update(request.body);return installs.view();});
  app.get('/api/system-installs/history',async()=>installs.history());
  app.post('/api/system-installs/:id/refresh',async request=>{z.object({}).strict().parse(request.body);return runtime.refreshInstall(paramId(request.params));});
  app.post('/api/system-installs/:id/status',async request=>{z.object({}).strict().parse(request.body);return installs.recover(paramId(request.params),false);});
  app.post('/api/system-installs/:id/reconcile',async request=>{z.object({}).strict().parse(request.body);return installs.recover(paramId(request.params),true);});
  app.patch('/api/preferences',async request=>settings.update(z.object({debugMode:z.boolean().optional(),defaultApprovalMode:approvalMode.optional()}).strict().parse(request.body)));
  app.post('/api/connection-check',async(request,reply)=> {
    z.object({}).strict().parse(request.body);
    const controller = new AbortController();
    const abort = () => { if (!reply.raw.writableEnded) controller.abort(); };
    request.raw.on('aborted',abort);
    reply.raw.on('close',abort);
    try { return await diagnostics.run(controller.signal); }
    finally { request.raw.off('aborted',abort);reply.raw.off('close',abort); }
  });
  app.get('/api/models',async()=>{
    const catalog=provider.catalog?await provider.catalog(): (await provider.models()).map(id=>({id,metadata:{},capabilities:{ordinary:'unknown',native:'unknown',streaming:'unknown'}}));
    return {models:catalog.map(entry=>entry.id),catalog};
  });
  const transfers=new ProjectTransfers(store,runtime,tools);
  const transferSignal=(request:any,reply:any)=>{
    const abort=new AbortController();
    const cancel=()=>{if(!reply.raw.writableEnded)abort.abort();};
    request.raw.once('aborted',cancel);reply.raw.once('close',cancel);
    return {signal:abort.signal,done:()=>{request.raw.off('aborted',cancel);reply.raw.off('close',cancel);}};
  };
  app.post('/api/project-transfers/import',async(request,reply)=>{
    if(config.executionMode!=='container')throw new Error('Managed transfer requires container mode');
    const input=z.object({name:z.string().trim().min(1).max(100),code:transferCode}).strict().parse(request.body);
    const pending=transferSignal(request,reply);
    try {const result=await transfers.import(input.name,input.code,pending.signal);watchProject(result.project.id);return reply.code(201).send(result);}
    finally {pending.done();}
  });
  app.post('/api/projects/:id/transfer-release',async request=>{
    if(config.executionMode!=='container')throw new Error('Managed transfer requires container mode');
    const {code}=z.object({code:transferCode}).strict().parse(request.body);return transfers.release(paramId(request.params),code);
  });
  app.post('/api/projects/:id/export',async(request,reply)=>{
    if(config.executionMode!=='container')throw new Error('Managed transfer requires container mode');
    const input=z.object({code:transferCode}).strict().parse(request.body),id=paramId(request.params);
    assertNoRequests(id,request.id);
    const pending=transferSignal(request,reply);
    try {return await transfers.export(id,input.code,pending.signal);} finally {pending.done();}
  });
  app.get('/api/projects',async()=>store.projects());
  app.get('/api/workspace',async()=>locations.settings());
  app.patch('/api/workspace',async request=>{const body=z.object({workspaceRoot:z.string().min(1).max(4096)}).strict().parse(request.body);return locations.update(body.workspaceRoot);});
  app.get('/api/directories',async request=>{const query=z.object({path:z.string().min(1).max(4096).optional()}).strict().parse(request.query);return locations.browse(query.path);});
  app.post('/api/projects',async(request,reply)=> {
    const body = z.object({name:z.string().trim().min(1).max(100),path:z.string().trim().min(1).max(4096).optional(),mode:z.enum(['create','import'])}).strict().parse(request.body);
    if(config.executionMode==='container' && body.mode==='import')throw new Error('Use the trusted host transfer flow to import a managed copy');
    if (body.mode==='import' && !body.path) throw new Error('Select the existing project folder to import');
    if (body.path && (!path.isAbsolute(body.path) || body.path.includes('\0'))) throw new Error('Use an absolute project folder path');
    let root = body.path ? path.resolve(body.path) : await locations.allocate(body.name);
    sandbox.validateRoot(root);
    if (root === path.parse(root).root) throw new Error('Choose a project folder, not the filesystem root');
    if (body.mode === 'create') {
      if (existsSync(root) && (await readdir(root)).length) throw new Error('New project folder must be empty; import an existing project instead');
      await mkdir(root,{recursive:true});
      // Empty repositories have a fixed portable layout. Do not run host Git:
      // ambient templates/config can execute or copy untrusted user content.
      for(const directory of ['objects','refs/heads','refs/tags'])await mkdir(path.join(root,'.git',directory),{recursive:true});
      await writeFile(path.join(root,'.git','HEAD'),'ref: refs/heads/main\n',{flag:'wx'});
      await writeFile(path.join(root,'.git','config'),'[core]\n\trepositoryformatversion = 0\n\tbare = false\n',{flag:'wx'});
    } else if (!(await stat(root)).isDirectory()) throw new Error('Project path must be a directory');
    root = await realpath(root);
    if (root === path.parse(root).root) throw new Error('Choose a project folder, not the filesystem root');
    const project = store.createProject(body.name,root); watchProject(project.id);
    return reply.code(201).send(project);
  });
  app.get('/api/projects/:id/chats',async request=> {const id = paramId(request.params);store.project(id);return store.chats(id);});
  app.post('/api/projects/:id/sandbox/reset',async request=>{
    z.object({}).strict().parse(request.body);
    const id=paramId(request.params),project=store.project(id);
    assertNoRequests(id,request.id);
    if(!tools.resetSandbox)throw Object.assign(new Error('Sandbox reset is unavailable for this tool service'),{statusCode:503});
    return runtime.exclusiveRemoval(id,async()=>{
      resetting.add(id);
      try{await tools.resetSandbox!(project.path);return {ok:true};}
      finally{resetting.delete(id);}
    });
  });
  app.post('/api/projects/:id/chats',async(request,reply)=> {
    const body = z.object({title:z.string().trim().min(1).max(200).optional(),approvalMode:approvalMode.optional()}).strict().parse(request.body);
    const id = paramId(request.params); watchProject(id);
    return reply.code(201).send(store.createChat(id,body.title ?? 'New chat',body.approvalMode ?? settings.get().defaultApprovalMode));
  });
  app.get('/api/chats/:id',async request=> {installs.expire();const id = paramId(request.params);watchProject(store.chat(id).projectId);return store.detail(id);});
  app.patch('/api/chats/:id',async request=> {
    const body = z.object({title:z.string().trim().min(1).max(200).optional(),approvalMode:approvalMode.optional()}).strict().parse(request.body);
    const id = paramId(request.params), chat = store.chat(id);
    if (body.approvalMode && body.approvalMode !== chat.approvalMode &&
        (['running','awaiting_approval'].includes(chat.status) || store.approvals(id).some(item=>item.status==='pending'))) {
      throw Object.assign(new Error('Pause the chat and resolve pending proposals before changing its approval mode'),{statusCode:409});
    }
    return store.updateChat(id,body);
  });
  app.post('/api/chats/:id/messages',async(request,reply)=> {
    const body = z.object({content:z.string().trim().min(1).max(100000)}).strict().parse(request.body);
    if (!config.baseUrl || !config.apiKey) return reply.code(503).send({error:'Set STARK_BASE_URL in the backend .env and restart for URL changes. Add the API key in Settings.'});
    await runtime.submit(paramId(request.params),body.content);
    return reply.code(202).send({accepted:true});
  });
  app.post('/api/chats/:id/start-building', async(request, reply) => {
    const body = z.object({planId:z.string().uuid(),planVersion:z.number().int().positive(),modeVersion:z.number().int().nonnegative()}).strict().parse(request.body);
    if (!config.baseUrl || !config.apiKey) return reply.code(503).send({error:'Configure the provider before starting to build.'});
    await runtime.startBuilding(paramId(request.params),body);
    return reply.code(202).send({accepted:true});
  });
  app.get('/api/chats/:id/goal',async request=>{const id=paramId(request.params);store.chat(id);return {goal:goalOf(store,id)??null};});
  app.post('/api/chats/:id/goal',async(request,reply)=>{
    const body=goalInput.parse(request.body);
    if(!config.baseUrl || !config.apiKey)return reply.code(503).send({error:'Configure the provider before starting a goal.'});
    return reply.code(202).send(await runtime.setGoal(paramId(request.params),body));
  });
  app.patch('/api/chats/:id/goal',async(request,reply)=>{
    const {expectedRevision,reason,...body}=goalRevisionInput.parse(request.body);
    if(!config.baseUrl || !config.apiKey)return reply.code(503).send({error:'Configure the provider before revising a goal.'});
    return reply.code(202).send(await runtime.setGoal(paramId(request.params),body,{expectedRevision,reason}));
  });
  app.post('/api/chats/:id/control',async request=> {const {action} = z.object({action:z.enum(['pause','resume','interrupt'])}).strict().parse(request.body);await runtime.control(paramId(request.params),action);return {ok:true};});
  app.post('/api/chats/:id/processes/:processId/cancel',async request=>{
    const {id,processId}=z.object({id:z.string().uuid(),processId:z.string().uuid()}).strict().parse(request.params);
    z.object({}).strict().parse(request.body);
    store.chat(id);return runtime.processes.cancel(processId,id);
  });
  app.post('/api/approvals/:id',async request=> {const {decision} = z.object({decision:z.enum(['approve','deny'])}).strict().parse(request.body);await runtime.decide(paramId(request.params),decision);return {ok:true};});
  app.get('/api/projects/:id/files',async request=> {const {path:relative} = z.object({path:z.string().optional()}).parse(request.query);return tools.list(store.project(paramId(request.params)).path,relative);});
  app.get('/api/projects/:id/previews',async request=>{z.strictObject({}).parse(request.query);return {...previews.list(paramId(request.params)),browserSupported:browserPreviews.supported()};});
  app.post('/api/projects/:id/previews/:processId/browser-probe',{bodyLimit:2048},async request=>{
    const {id,processId}=z.strictObject({id:z.uuid(),processId:z.uuid()}).parse(request.params),{documentId}=z.strictObject({documentId:z.uuid()}).parse(request.body);if(!options.transportAuth)throw new Error('Paired browser required');return browserPreviews.start(id,processId,options.transportAuth.browserPrincipal(request),documentId,request);
  });
  app.post('/api/projects/:id/previews/browser-advance',{bodyLimit:2048},async request=>{
    const {id}=z.strictObject({id:z.uuid()}).parse(request.params),input=z.strictObject({documentId:z.uuid(),result:browserProbeResult}).parse(request.body);if(!options.transportAuth)throw new Error('Paired browser required');return browserPreviews.advance(id,options.transportAuth.browserPrincipal(request),input);
  });
  app.post('/api/projects/:id/previews/:browserId/browser-close',{bodyLimit:2048},async request=>{
    const {id,browserId}=z.strictObject({id:z.uuid(),browserId:z.uuid()}).parse(request.params),{documentId}=z.strictObject({documentId:z.uuid()}).parse(request.body);if(!options.transportAuth)throw new Error('Paired browser required');return browserPreviews.close(id,options.transportAuth.browserPrincipal(request),documentId,browserId);
  });
  app.post('/api/projects/:id/previews/:processId/open',async request=>{
    const {id,processId}=z.strictObject({id:z.uuid(),processId:z.uuid()}).parse(request.params);z.strictObject({}).parse(request.body);return previews.open(id,processId);
  });
  app.post('/api/projects/:id/previews/:previewId/resource',async(request,reply)=>{
    const {id,previewId}=z.strictObject({id:z.uuid(),previewId:z.uuid()}).parse(request.params);const input=z.strictObject({path:previewPath}).parse(request.body);
    const abort=new AbortController();const cancel=()=>abort.abort();request.raw.once('aborted',cancel);const close=()=>{if(!reply.raw.writableEnded)abort.abort();};reply.raw.once('close',close);
    try{return await previews.resource(id,previewId,input.path,abort.signal);}finally{request.raw.off('aborted',cancel);reply.raw.off('close',close);}
  });
  app.post('/api/projects/:id/previews/:previewId/close',async request=>{
    const {id,previewId}=z.strictObject({id:z.uuid(),previewId:z.uuid()}).parse(request.params);z.strictObject({}).parse(request.body);return previews.close(id,previewId);
  });
  app.get('/api/projects/:id/checkpoints',async request=>checkpoints.list(paramId(request.params)));
  app.post('/api/projects/:id/checkpoints',async(request,reply)=>reply.code(201).send(await checkpoints.capture(paramId(request.params),captureCheckpointInput.parse(request.body))));
  app.post('/api/projects/:id/checkpoints/:checkpointId/preview',async request=>{
    const {id,checkpointId}=z.strictObject({id:z.uuid(),checkpointId:z.uuid()}).parse(request.params);
    return checkpoints.preview(id,checkpointId,previewCheckpointInput.parse(request.body));
  });
  app.post('/api/projects/:id/checkpoints/:checkpointId/restore',async request=>{
    const {id,checkpointId}=z.strictObject({id:z.uuid(),checkpointId:z.uuid()}).parse(request.params);
    return checkpoints.restore(id,checkpointId,restoreCheckpointInput.parse(request.body));
  });
  app.get('/api/projects/:id/changes',async request=>changes.list(paramId(request.params)));
  app.get('/api/projects/:id/diff',async request=>{
    const {path} = z.object({path:z.string().min(1).max(4096)}).strict().parse(request.query);
    return changes.diff(paramId(request.params),path);
  });
  app.get('/api/projects/:id/change/:changeId',async request=>{
    const {id,changeId} = z.object({id:z.string(),changeId:z.string()}).parse(request.params);
    return changes.preview(id,changeId);
  });
  app.post('/api/projects/:id/change/:changeId/undo',async request=>{
    const {id,changeId} = z.object({id:z.string(),changeId:z.string()}).parse(request.params);
    const {expectedHash,previewToken} = z.object({expectedHash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),previewToken:z.string().uuid()}).strict().parse(request.body);
    return changes.undo(id,changeId,expectedHash,previewToken);
  });
  app.get('/api/projects/:id/file',async request=> {const {path:relative} = z.object({path:z.string().min(1)}).parse(request.query);return tools.read(store.project(paramId(request.params)).path,relative);});
  app.put('/api/projects/:id/file',async request=> {
    const body = z.object({path:z.string().min(1),content:z.string().max(1024*1024),baseHash:z.string().nullable(),owner:z.string().min(1).max(200)}).strict().parse(request.body);
    const project = store.project(paramId(request.params));
    const saved = await tools.save(project.path,body.path,body.content,body.baseHash,body.owner);
    runtime.notifyFileChange(project.id,saved.path,'editor');
    for (const chat of store.chats(project.id)) store.event(chat.id,'file_changed',{path:saved.path,source:'editor',hash:saved.hash});
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
    const cleanup = () => {clearInterval(heartbeat);store.changes.off(id,send);eventStreams.delete(reply.raw);chatStreams.get(id)?.delete(reply.raw);if (!chatStreams.get(id)?.size) chatStreams.delete(id);};
    if (!chatStreams.has(id)) chatStreams.set(id,new Map());
    chatStreams.get(id)!.set(reply.raw,cleanup);
    reply.raw.on('close',cleanup);
  });
  const staticRoot = options.staticRoot ?? path.join(installationRoot,'dist/client');
  if (existsSync(staticRoot)) {
    await app.register(staticFiles,{root:staticRoot,prefix:'/',index:'index.html'});
    app.setNotFoundHandler((request,reply)=>request.url.startsWith('/api') ? reply.code(404).send({error:'API route not found'}) : reply.sendFile('index.html'));
  }
  // Persist runtime/goal shutdown before an embedding owner's onClose hook can
  // close its supplied Store. Runtime.close is idempotent for the later hook.
  app.addHook('preClose',async()=>{closing=true;browserPreviews.shutdown();previews.shutdown();installs.beginClose();for(const stream of eventStreams) stream.end();await diagnostics.close();await runtime.close();});
  app.addHook('onClose',async()=> {for (const watcher of watchers.values()) watcher.close();for (const timer of pendingChanges.values()) clearTimeout(timer);await runtime.close();await tools.dispose();if (!options.store) store.close();});
  return {app,store,runtime,installs,previews,browserPreviews,queues};
}
