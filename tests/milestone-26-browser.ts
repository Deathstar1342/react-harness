// Actual browser, HTTP, SQLite and filesystem. No model or shell execution.
import path from 'node:path';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {chromium,expect} from '@playwright/test';
import {createApp} from '../server/app.js';
import {readConfig} from '../server/config.js';
import {Store} from '../server/store.js';
import {WorkspaceTools} from '../server/tools/index.js';
import {roleInstructions} from '../server/prompts.js';
import {TransportAuth} from '../server/transport-auth.js';

const root=await mkdtemp(path.join(tmpdir(),'m26-browser-')),home=path.join(root,'app'),projectRoot=path.join(root,'project');
await mkdir(home);await mkdir(projectRoot);await writeFile(path.join(projectRoot,'sample.txt'),'Original file');
const config=readConfig({PORT:'3190',HARNESS_HOME:home,HARNESS_DATA_DIR:path.join(home,'data'),HARNESS_WORKSPACE_ROOT:path.join(root,'workspaces'),STARK_BASE_URL:'http://127.0.0.1:1',STARK_API_KEY:'synthetic-test'});
const store=new Store(path.join(home,'state.sqlite')),tools=new WorkspaceTools(),auth=new TransportAuth('m26-browser');
const project=store.createProject('Skills browser',projectRoot),chat=store.createChat(project.id,'Workflow browser','review');store.createChat(project.id,'Other chat','review');
const {app}=await createApp({config,store,tools,hooks:{instructions:roleInstructions},transportAuth:auth,provider:{models:async()=>[],complete:async()=>{throw new Error('Browser fixture must not invoke model');}}});
const address=await app.listen({host:'127.0.0.1',port:config.port}),browser=await chromium.launch({channel:'chrome',headless:true});
const receipts=process.env.M26_RECEIPTS??'test-results';await mkdir(receipts,{recursive:true});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1050},extraHTTPHeaders:{authorization:`Bearer ${auth.token}`}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{const win=window as unknown as {__dirty:boolean[];abyssusDesktop?:unknown};win.__dirty=[];Object.defineProperty(win,'abyssusDesktop',{value:undefined,writable:true});});
  await page.goto(address);await page.getByRole('navigation',{name:'Conversations'}).getByRole('button',{name:/^Workflow browser/}).click();
  await page.getByRole('button',{name:'Skills',exact:true}).click();
  await page.getByLabel('Skill name').fill('verify');await page.getByLabel('Skill description').fill('Repeat reliable verification');await page.getByLabel('Workflow steps').fill('Inspect changes. Run appropriate checks. Report observed results.');
  // Programmatic clicks deliberately exercise the App guard behind the modal;
  // ordinary pointer navigation is already excluded by the native dialog.
  await page.getByRole('navigation',{name:'Conversations'}).getByRole('button',{name:'Other chat',exact:true}).evaluate((button:HTMLButtonElement)=>button.click());
  await expect(page.getByRole('heading',{name:'Workflow browser',exact:true})).toBeVisible();
  await expect(page.getByLabel('Workflow steps')).toHaveValue('Inspect changes. Run appropriate checks. Report observed results.');
  await page.getByRole('button',{name:'Close Skills',exact:true}).click();await expect(page.getByText('Discard unsaved skill edits?',{exact:false})).toBeVisible();await page.getByRole('button',{name:'Keep editing',exact:true}).click();
  await page.getByRole('button',{name:'Create draft',exact:true}).click();await expect(page.getByLabel('Workflow document')).toContainText('Inspect changes');
  await page.getByRole('button',{name:'Preview save',exact:true}).click();await expect(page.getByRole('region',{name:'Skill save preview'})).toContainText('.abyssus/skills/verify/SKILL.md');
  await page.screenshot({path:path.join(receipts,'m26-save-preview.png'),fullPage:true});
  await page.getByRole('button',{name:'Confirm save',exact:true}).click();await expect(page.getByRole('status')).toContainText('Status: confirmed');
  const filename=path.join(projectRoot,'.abyssus/skills/verify/SKILL.md');expect(await readFile(filename,'utf8')).toContain('Inspect changes');
  await page.getByRole('button',{name:'Invoke guidance',exact:true}).click();await expect(page.getByText('Selection revision 1 · pinned')).toBeVisible();expect(store.chat(chat.id).status).toBe('paused');
  await page.getByRole('button',{name:'Promote to personal',exact:true}).click();await expect(page.getByRole('region',{name:'Skill save preview'})).toContainText(path.join(home,'skills','verify'));
  await page.getByRole('button',{name:'Confirm personal promotion',exact:true}).click();await expect(page.getByRole('status')).toContainText(path.join(home,'skills','verify'));expect(await readFile(path.join(home,'skills/verify/SKILL.md'),'utf8')).toContain('Inspect changes');
  const original=await page.getByLabel('Workflow document').inputValue();await page.getByLabel('Workflow document').fill(original+'\nRetained browser edit.');
  await writeFile(filename,original+'\nManual disk change.');
  await page.getByRole('button',{name:'Preview save',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'stale file version'})).toBeVisible();expect(await page.getByLabel('Workflow document').inputValue()).toContain('Retained browser edit');
  await page.screenshot({path:path.join(receipts,'m26-manual-conflict.png'),fullPage:true});
  await page.getByRole('button',{name:'Close Skills',exact:true}).click();await page.getByRole('button',{name:'Discard and close',exact:true}).click();
  // Released skill lease must permit an independent authenticated manual editor save.
  const manual=await tools.read(projectRoot,'.abyssus/skills/verify/SKILL.md');await tools.save(projectRoot,manual.path,manual.content+'\nReleased lease.',manual.hash,'other-tab');
  await page.getByRole('navigation',{name:'Conversations'}).getByRole('button',{name:'Other chat',exact:true}).click();await expect(page.getByRole('heading',{name:'Other chat',exact:true})).toBeVisible();
  await page.reload();await page.getByRole('navigation',{name:'Conversations'}).getByRole('button',{name:/^Workflow browser/}).click();await page.getByRole('button',{name:'Skills',exact:true}).click();await expect(page.getByText(/Selection revision 1/)).toBeVisible();
  await page.screenshot({path:path.join(receipts,'m26-reloaded-selection.png'),fullPage:true});
  expect(errors).toEqual([]);
  console.log('PASS actual headless Chrome: draft/create, exact diff/save, guidance selection without execution, authenticated personal promotion, manual conflict retained buffer, modal discard/lease release, chat switch and persisted selection. No model, native-human or installed-device claim.');
} finally {await browser.close();await app.close();store.close();await rm(root,{recursive:true,force:true});}
