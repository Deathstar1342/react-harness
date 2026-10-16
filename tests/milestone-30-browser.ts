// Real headless Chrome and HTTP; transfer receipts are explicitly synthetic UI fixtures.
import path from 'node:path';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {createApp} from '../server/app.js';
import {readConfig} from '../server/config.js';
import {Store} from '../server/store.js';
import {WorkspaceTools} from '../server/tools/index.js';
import {roleInstructions} from '../server/prompts.js';
const root=await mkdtemp(path.join(tmpdir(),'m30-browser-')),home=path.join(root,'home'),projectRoot=path.join(root,'project');
await mkdir(home);await mkdir(projectRoot);
const config=readConfig({PORT:'3196',HARNESS_HOME:home,HARNESS_DATA_DIR:path.join(home,'data'),HARNESS_WORKSPACE_ROOT:path.join(root,'workspace')});
const store=new Store(path.join(home,'state.sqlite')),tools=new WorkspaceTools();
const project={...store.createProject('Imported copy',projectRoot),path:'/workspace/'+randomUUID()};
const {app}=await createApp({config,store,tools,hooks:{instructions:roleInstructions},provider:{models:async()=>[],complete:async()=>{throw Error('No provider in UI fixture');}}});
const address=await app.listen({host:'127.0.0.1',port:3196});
const browser=await chromium.launch({channel:'chrome',headless:true});
const receipts=process.env.M30_RECEIPTS??'test-results';await mkdir(receipts,{recursive:true});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  let imported=false,imports=0,exports=0,browsing=0;
  const receipt={id:randomUUID(),kind:'import',project:project.path.split('/').at(-1),phase:'succeeded',code:'COMPLETE_WITH_EXCLUSIONS',residue:false,manifestDigest:'a'.repeat(64),files:14,bytes:2048,excludedCount:2,excluded:[{path:'.env',reason:'Sensitive project file; explicit host inclusion required'},{path:'node_modules',reason:'Dependency, build or cache directory'}],history:false,storageId:randomUUID(),sessionId:randomUUID(),identity:[1,2]};
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url());
    const reply=(json:unknown)=>route.fulfill({json});
    if(url.pathname==='/api/settings'){const response=await route.fetch();return reply({...await response.json(),executionMode:'container',executionAvailable:true});}
    if(url.pathname==='/api/projects'&&request.method()==='GET')return reply(imported?[project]:[]);
    if(url.pathname==='/api/workspace')return reply({workspaceRoot:'/workspace',defaultWorkspaceRoot:'/workspace',transferMode:'source-code'});
    if(url.pathname==='/api/directories'){browsing++;return reply({error:'Host paths must not be browsed'});}
    if(url.pathname==='/api/project-transfers/import'){
      expect(request.postDataJSON()).toEqual({name:'Imported copy',code:'b'.repeat(64)});imports++;imported=true;return reply({project,receipt});
    }
    if(url.pathname.endsWith('/export')){expect(request.postDataJSON()).toEqual({code:'c'.repeat(64)});exports++;return reply({...receipt,kind:'export'});}
    await route.continue();
  });
  await page.goto(address);
  await page.getByRole('button',{name:'Add project',exact:true}).click();
  await page.getByRole('button',{name:'Import existing',exact:true}).click();
  await expect(page.getByText('Container source flow:',{exact:false})).toBeVisible();
  await expect(page.getByText('bash scripts/project-transfer.sh',{exact:true})).toBeVisible();
  await page.getByLabel('Project name').fill('Imported copy');await page.getByLabel('Transfer code').fill('b'.repeat(64));
  await page.screenshot({path:path.join(receipts,'m30-import-review.png'),fullPage:true});
  await page.getByRole('button',{name:'Import copy',exact:true}).click();
  await expect(page.getByText('Copy completed:',{exact:false})).toBeVisible();
  await page.getByText('Excluded files and folders',{exact:true}).click();await expect(page.getByText('.env',{exact:true})).toBeVisible();
  await page.screenshot({path:path.join(receipts,'m30-import-exclusions.png'),fullPage:true});
  await page.getByRole('button',{name:'Open project',exact:true}).click();
  await page.getByRole('button',{name:'Project Imported copy options',exact:true}).click();
  await page.getByRole('button',{name:'Export project copy',exact:true}).click();
  await expect(page.getByText('Managed folder identity:',{exact:false})).toBeVisible();
  await page.getByLabel('Transfer code').fill('c'.repeat(64));await page.getByRole('button',{name:'Export copy',exact:true}).click();
  await expect(page.getByText('Copy completed:',{exact:false})).toBeVisible();
  await page.screenshot({path:path.join(receipts,'m30-export-receipt.png'),fullPage:true});
  expect(imports).toBe(1);expect(exports).toBe(1);expect(browsing).toBe(0);expect(errors).toEqual([]);
  console.log('PASS actual headless Chrome with synthetic transfer receipts: honest host-code flow, no host-path browser requests, exclusion review, project selection, quiet export menu and receipt. No native-dialog/container claim.');
}finally{await browser.close();await app.close();store.close();await rm(root,{recursive:true,force:true});}
