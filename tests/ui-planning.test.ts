import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PlanPanel } from '../client/Panels.js';

it('shows revision resets, linked actual evidence and bounded history without hiding blocked steps',()=>{
  const html=renderToStaticMarkup(createElement(PlanPanel,{plan:{id:'plan',version:2,phases:[{id:'phase',title:'Phase',steps:[{id:'step',title:'Waiting for review',status:'blocked',evidence:{eventId:30,delegationId:'worker',outcome:'changes_requested',summary:'Missing verification',sourceEventId:29}}]}]},events:[{id:30,chatId:'chat',type:'plan_progress',createdAt:'',data:{planVersion:2,stepId:'step',outcome:'changes_requested',summary:'Missing verification',sourceEventId:29}},{id:29,chatId:'chat',type:'review',createdAt:'',data:{passed:false,findings:['<untrusted>']}}]}));
  expect(html).toContain('0 / 1 steps');expect(html).toContain('Scope revisions reset current progress');expect(html).toContain('Source evidence #29');expect(html).toContain('Missing verification');expect(html).toContain('&lt;untrusted&gt;');expect(html).toContain('blocked');
});
it('offers an honest empty plan and retained summary when source events are outside recent history',()=>{
  expect(renderToStaticMarkup(createElement(PlanPanel,{plan:{phases:[]}}))).toContain('No plan yet');
  const html=renderToStaticMarkup(createElement(PlanPanel,{plan:{phases:[]},events:[{id:30,chatId:'c',type:'plan_progress',createdAt:'',data:{sourceEventId:1}}]}));
  expect(html).toContain('Source is outside recent history');
});
