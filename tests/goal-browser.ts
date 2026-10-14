// Disposable Chromium UI + actual HTTP/runtime/SQLite/file verification.
// Synthetic provider; no STARK, installed preview, WSL or privileged operations.
// npm run build; node --import tsx tests/goal-browser.ts
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { roleInstructions } from '../server/prompts.js';
import { orchestrationFixture, call, complete, pass, stateOf } from './orchestration-fixture.js';

const t=await orchestrationFixture(2);await t.seed();
t.store.updateChat(t.chat.id,{mode:'plan',modeVersion:1});
t.replies.push({text:'Goal captured in planning mode. Start building explicitly to inspect and review the files.',finishReason:'stop'});
for(let phase=1;phase<=2;phase++)t.replies.push(input=>{const goal=stateOf(input).goal;return t.delegate(phase,{goal:{goalId:goal.id,goalRevision:goal.revision,criterionIds:goal.criteria.map((item:{id:string})=>item.id)}});},call('read_file',{path:'result.txt'}),complete(),call('read_file',{path:'result.txt'}),pass());
t.replies.push(input=>{const {goal,plan,modeVersion}=stateOf(input);return call('request_goal_completion',{goalId:goal.id,goalRevision:goal.revision,planId:plan.id,planVersion:plan.version,modeVersion,reviewEventIds:goal.reviews.map((item:{eventId:number})=>item.eventId)});});
const config=readConfig({PORT:'3186',STARK_BASE_URL:'http://127.0.0.1:1/synthetic',STARK_API_KEY:'synthetic-fixture',HARNESS_DATA_DIR:path.join(t.root,'data'),HARNESS_WORKSPACE_ROOT:path.join(t.root,'workspace')});
const {app}=await createApp({config,store:t.store,provider:t.provider,tools:t.tools,hooks:{instructions:roleInstructions}});
const address=await app.listen({host:'127.0.0.1',port:config.port});
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(address);await page.getByRole('navigation',{name:'Conversations'}).getByRole('button',{name:'Scenario',exact:true}).click();
  await page.getByRole('button',{name:'/goal',exact:true}).click();
  const composer=page.getByRole('textbox',{name:'Message the architect'});
  await composer.fill('/goal Inspect both phases\n- Read and independently review the required files');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  const indicator=page.getByRole('button',{name:/Goal · waiting for user · 0\/2 phases/});await expect(indicator).toBeVisible();
  await indicator.click();await expect(page.getByRole('region',{name:'Durable goal'})).toContainText('Planning only');
  await page.getByRole('button',{name:'Start building',exact:true}).click();
  await expect(page.getByRole('button',{name:/Goal · completed · 2\/2 phases/})).toBeVisible();
  await expect(page.getByRole('region',{name:'Durable goal'})).toContainText('All protected requirements');
  await page.getByRole('button',{name:'Revise goal scope',exact:true}).click();
  await expect(page.getByLabel('Acceptance criteria · one per line')).toHaveValue('Read and independently review the required files');
  await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/goal-browser.png',fullPage:true});
  // Keep the draft open while a second human client revises the same goal.
  t.replies.push(call('ask_user',{question:'Review the newly requested criterion.'}));
  const update=await page.request.patch(`${address}/api/chats/${t.chat.id}/goal`,{data:{objective:'Concurrent human objective',acceptanceCriteria:['Concurrent criterion'],expectedRevision:1,reason:'Explicit concurrent human change'}});
  expect(update.status()).toBe(202);
  await expect(page.getByRole('region',{name:'Durable goal'})).toContainText('Goal changed since this draft opened');
  await page.getByLabel('Why this scope changes').fill('Attempt to save original draft');
  await page.getByRole('button',{name:'Save explicit revision'}).click();
  await expect(page.getByRole('region',{name:'Durable goal'})).toContainText('explicitly revise its current revision');
  await expect(page.getByLabel('Acceptance criteria · one per line')).toHaveValue('Read and independently review the required files');
  expect((await page.request.get(`${address}/api/chats/${t.chat.id}/goal`)).status()).toBe(200);
  const saved=(await (await page.request.get(`${address}/api/chats/${t.chat.id}/goal`)).json()).goal;
  expect(saved.revision).toBe(2);expect(saved.criteria[0].text).toBe('Concurrent criterion');
  await page.screenshot({path:'test-results/goal-browser-conflict.png',fullPage:true});
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'Close plan',exact:true}).click();await expect(page.getByRole('region',{name:'Current plan'})).toHaveCount(0);
  await page.reload();await expect(page.getByRole('button',{name:/Goal · waiting for user/})).toBeVisible();
  if(errors.length)throw new Error(errors.join('\n'));
  console.log('PASS headless Chrome actual goal command, compact indicator, planning gate, two-phase completion, concurrent revision conflict with retained draft, collapse and reload. Synthetic provider only.');
} finally {await browser.close();await app.close();await t.close();}
