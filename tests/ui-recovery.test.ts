import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import {RecoveryContent,recoveryFreshness} from '../client/RecoveryPanel';
import {Store} from '../server/store.js';
import {recoveryView} from '../server/recovery.js';

describe('recovery UI semantics',()=>{
  it('labels unknown/omitted evidence, original IDs and navigation without any effect controls',()=>{
    const store=new Store(':memory:');try{
      const project=store.createProject('p','/p'),chat=store.createChat(project.id,'c','review');store.initializePlanning();
      store.event(chat.id,'command',{commandId:'command-original',agentId:'coder-original',action:{name:'run_shell',args:{command:'PRIVATE_ARGUMENT'}},status:'uncertain'});
      const view=recoveryView(store,chat.id);view.coverage[0].truncated=true;
      const html=renderToStaticMarkup(createElement(RecoveryContent,{view,stale:true,onNavigate:()=>{throw new Error('Rendering must never navigate or execute');}}));
      for(const text of ['Uncertain','stale','omitted or unavailable','Event #','command-original','coder-original','Review Resume / pause controls','Open command evidence'])expect(html).toContain(text);
      for(const text of ['PRIVATE_ARGUMENT','>Resume</button>','>Reconcile installed state</button>','>Cancel process</button>'])expect(html).not.toContain(text);
    }finally{store.close();}
  });
  it('marks changed chat/event/mode/goal/plan revisions stale and cannot confuse chat responses',()=>{
    const store=new Store(':memory:');try{
      const project=store.createProject('p','/p'),chat=store.createChat(project.id,'c','review');store.initializePlanning();const view=recoveryView(store,chat.id),detail=store.detail(chat.id);
      expect(recoveryFreshness(view,detail)).toBe(true);
      expect(recoveryFreshness(view,{...detail,chat:{...detail.chat,id:'another'}})).toBe(false);
      expect(recoveryFreshness(view,{...detail,chat:{...detail.chat,modeVersion:9}})).toBe(false);
      expect(recoveryFreshness(view,{...detail,plan:{id:'new-plan',version:1,phases:[]}})).toBe(false);
      store.event(chat.id,'steering',{content:'private'});expect(recoveryFreshness(view,store.detail(chat.id))).toBe(false);
    }finally{store.close();}
  });
});
