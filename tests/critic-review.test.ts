import {afterEach,expect,it,vi} from 'vitest';
import {reserveMutation} from '../server/tools/mutations.js';
import {estimateTokens} from '../server/scheduler.js';
import {criticEvidencePrefix} from '../server/review-context.js';
import type {RunState} from '../server/runtime.js';
import {call,complete,orchestrationFixture,pass,stateOf,testResult,type Input} from './orchestration-fixture.js';

const cleanup: (()=>Promise<void>)[] = [];
afterEach(async()=>{
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(boundary?: ()=>void|Promise<void>) {
  const test = await orchestrationFixture(1,true,boundary);
  cleanup.push(test.close);
  return test;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const evidence = (input: Input) => input.messages.find(message=>message.content.startsWith(criticEvidencePrefix));
const review = (test: Fixture) => test.store.events(test.chat.id).filter(event=>event.type==='review').map(event=>event.data);
const receipt = (test: Fixture, name: string) => test.store.events(test.chat.id).findLast(event=>
  event.type==='tool' && (event.data as {action?:{name:string};result?:object}).action?.name===name &&
  (event.data as {result?:object}).result)?.id;
const state = (test: Fixture) => test.store.getState<RunState>('run:'+test.chat.id,null!);
const step = (test: Fixture) => test.store.plan(test.chat.id).phases[0].steps[0];
const read = () => call('read_file',{path:'result.txt'});
const verification = () => call('run_tests',{command:'fixture verification command',reportPath:'report.xml'});
const change = async(test: Fixture,content: string) => {
  const original = await test.tools.read(test.root,'result.txt');
  return call('write_file',{path:'result.txt',baseHash:original.hash,content});
};
const repairs = () => call('review_result',{verdict:'changes_requested',findings:['Correct the observed output inside the assigned file.']});
const replan = (id: number, verdict='changes_requested') => call('review_result',{verdict,findings:[],replan:{
  reason:'dependency_blocked',explanation:'The required dependency check failed. Decide whether the plan can rely on this dependency.',evidenceEventIds:[id],
}});

it('gives a completion Critic a bounded current receipt-relative patch and exact validation status',async()=>{
  const test = await fixture(()=>{});
  await test.seed('result.txt','original-line\n');
  const result = testResult('passed');
  (result.data as {testReport:{tests:unknown[]}}).testReport.tests.push({name:'Other platform',status:'skipped'});
  test.commandResults.push(result);
  test.replies.push(test.delegate(),async()=>change(test,'intermediate-line\n'),async()=>change(test,'final-line\n'),verification(),
    call('submit_completion',{summary:'UNTRUSTED CODER SUMMARY'}),input=>{
      const packet = evidence(input)!;
      expect(packet.content).toContain('-original-line');
      expect(packet.content).toContain('+final-line');
      expect(packet.content).toContain('Git HEAD/index and broader drift are unverified');
      expect(packet.content).toContain('"skipped":1');
      expect(packet.content).toContain('"check":"passed at recorded scope"');
      expect(packet.content).not.toContain('intermediate-line');
      expect(JSON.stringify(input.messages)).not.toContain('UNTRUSTED CODER SUMMARY');
      expect(packet.content).not.toContain('fixture verification command');
      expect(estimateTokens([packet])-estimateTokens([])).toBeLessThanOrEqual(2048);
      expect(stateOf(input).assignment).toMatchObject({paths:['result.txt','README.md'],planStep:test.reference()});
      return pass();
    },input=>{
      expect(stateOf(input).role).toBe('architect');
      const joined=JSON.stringify(input.messages);
      expect(joined).toContain('Runtime disposition: accepted');
      expect(joined).not.toContain('original-line');
      expect(joined).not.toContain('fixture verification command');
      return complete();
    });
  await test.run();
  expect(test.executed.map(item=>item.name)).toEqual(['write_file','write_file','run_tests']);
  expect(test.requests).toHaveLength(7);
  expect(review(test)).toEqual([expect.objectContaining({passed:true,disposition:'accepted',evidenceStatus:'observed'})]);
  expect(step(test).status).toBe('done');
  expect(JSON.stringify(test.store.db.prepare("SELECT data FROM state WHERE key LIKE 'native:frame:%'").all())).not.toContain(criticEvidencePrefix);
});

it('drops a once-current source body after the managed scheduler boundary',async()=>{
  let test: Fixture;
  test = await fixture(()=>test.seed('result.txt','external-line\n'));
  await test.seed('result.txt','original-line\n');
  test.replies.push(test.delegate(),async()=>change(test,'late-stale-line\n'),complete(),input=>{
    const packet=evidence(input)!;
    expect(packet.content).toContain('Omitted or stale source entries:');
    expect(packet.content).not.toContain('late-stale-line');
    expect(packet.content).not.toContain('external-line');
    return pass();
  },complete());
  await test.run();
  expect(review(test)).toEqual([expect.objectContaining({passed:true,disposition:'unaccepted',evidenceStatus:'unavailable'})]);
  expect(step(test).status).toBe('blocked');
  expect(test.executed.map(item=>item.name)).toEqual(['write_file']);
});

it('hands a certain failed original receipt to Architect once without changing the plan revision',async()=>{
  const test=await fixture();
  await test.seed();
  test.commandResults.push(testResult('failed'));
  test.replies.push(test.delegate(),verification(),complete(),input=>{
    expect(evidence(input)?.content).toContain('"check":"failed at recorded scope"');
    return replan(receipt(test,'run_tests')!);
  },input=>{
    expect(stateOf(input).role).toBe('architect');
    expect(state(test).frames.map(frame=>frame.role)).toEqual(['architect']);
    expect(JSON.stringify(input.messages)).toContain('dependency_blocked');
    expect(JSON.stringify(input.messages)).not.toContain('fixture verification command');
    return complete();
  });
  await test.run();
  expect(review(test)).toEqual([expect.objectContaining({passed:false,disposition:'replan',reason:'dependency_blocked'})]);
  expect(test.store.plan(test.chat.id).version).toBe(test.reference().planVersion);
  expect(step(test).evidence?.outcome).toBe('replan_requested');
  expect(test.executed).toHaveLength(1);
});

it('refuses a failed verification receipt after its observed scope changes',async()=>{
  const test=await fixture();
  await test.seed();
  test.commandResults.push(testResult('failed'),testResult('passed'));
  test.replies.push(test.delegate(),verification(),complete(),async()=>{
    await test.seed('result.txt','New content, outside the recorded verification\n');
    return replan(receipt(test,'run_tests')!);
  },input=>{
    expect(review(test)).toHaveLength(0);
    expect(state(test).frames.at(-2)?.repairs).toBe(0);
    expect(input.messages.at(-1)?.content).toContain('Replanning requires current exact receipts');
    return repairs();
  },verification(),complete(),pass(),complete());
  await test.run();
  expect(review(test)).toEqual(['local_repair','accepted'].map(disposition=>expect.objectContaining({disposition})));
  expect(step(test).status).toBe('done');
});

it('keeps an invalid replan in the original Critic then spends only two actual local repairs',async()=>{
  const test=await fixture();
  await test.seed();
  const foreignChat=test.store.createChat(test.chat.projectId,'Foreign task','autonomous');
  const foreign=test.store.event(foreignChat.id,'tool',{result:{ok:false},action:{name:'run_tests'}}).id;
  let coderId: string, generation: number;
  const sameCoder = (input: Input) => {
    const current=state(test);
    expect(stateOf(input).role).toBe('coder');
    expect(current.frames.at(-1)?.id).toBe(coderId);
    expect(current.generation).toBe(generation);
    expect(current.frames.at(-1)?.scope).toEqual(['result.txt','README.md']);
    return complete();
  };
  test.replies.push(test.delegate(),read(),complete(),()=>{
    const current=state(test);
    coderId=current.frames.at(-2)!.id;
    generation=current.generation;
    return replan(foreign);
  },input=>{
    expect(stateOf(input).role).toBe('critic');
    expect(state(test).frames.at(-2)?.repairs).toBe(0);
    expect(review(test)).toHaveLength(0);
    expect(input.messages.at(-1)?.content).toContain('Replanning requires current exact receipts');
    return replan(receipt(test,'read_file')!,'pass');
  },input=>{
    expect(input.messages.at(-1)?.content).toContain('Entire native batch rejected');
    expect(state(test).frames.at(-2)?.repairs).toBe(0);
    return repairs();
  },sameCoder,repairs(),sameCoder,repairs(),complete());
  await test.run();
  expect(review(test)).toEqual(['local_repair','local_repair','unaccepted'].map(disposition=>expect.objectContaining({disposition})));
  expect(test.executed).toHaveLength(1);
});

it('uses both confirmed move paths for a scoped assignment-relative patch',async()=>{
  const test=await fixture();
  await test.seed('result.txt','move-this-line\n');
  const before=await test.tools.read(test.root,'result.txt');
  test.replies.push(test.delegate(1,{paths:['result.txt','moved.txt']}),
    call('rename_file',{path:'result.txt',destination:'moved.txt',baseHash:before.hash}),complete(),input=>{
      const packet=evidence(input)!;
      expect(packet.content).toContain('-move-this-line');
      expect(packet.content).toContain('+move-this-line');
      expect(packet.content).toContain('moved.txt');
      return pass();
    },complete());
  await test.run();
  expect(step(test).status).toBe('done');
  expect(review(test)).toEqual([expect.objectContaining({disposition:'accepted'})]);
});

it('accepts the same successful exact legacy read and raw pass shape',async()=>{
  const test=await fixture();
  await test.seed();
  test.replies.push(test.delegate(),read(),complete(),()=>{
    const id=receipt(test,'read_file')!;
    test.store.db.prepare("UPDATE events SET data=json_remove(data,'$.reviewReceipt') WHERE id=?").run(id);
    return pass();
  },complete());
  await test.run();
  expect(review(test)).toEqual([expect.objectContaining({passed:true,disposition:'accepted'})]);
});

it.each(['wrong-origin','malformed','duplicate','overflow','missing'])('refuses acceptance based on %s receipt coverage',async kind=>{
  const test=await fixture();
  await test.seed();
  const replies = kind==='missing' ? [] : [read()];
  test.replies.push(test.delegate(),...replies,complete(),input=>{
    if (kind==='missing') {
      expect(evidence(input)?.content).toContain('Git HEAD/index and broader drift are unverified');
      return pass();
    }
    const id=receipt(test,'read_file')!;
    if (kind==='wrong-origin') {
      test.store.db.prepare("UPDATE events SET data=json_set(data,'$.reviewReceipt.origin','foreign') WHERE id=?").run(id);
    } else if (kind==='malformed') {
      test.store.db.prepare("UPDATE events SET data=substr(data,1,length(data)-1)||? WHERE id=?").run(',"agentId":"foreign"}',id);
    } else {
      const live=(test.runtime as unknown as {runs:Map<string,RunState>}).runs.get(test.chat.id)!;
      live.frames.at(-2)!.evidenceEventIds=Array.from({length:kind==='duplicate'?2:101},()=>id);
    }
    return pass();
  },complete());
  await test.run();
  expect(review(test)).toEqual([expect.objectContaining({passed:true,disposition:'unaccepted'})]);
  expect(step(test).status).toBe('blocked');
});

it('refuses a verdict while a real project reservation is held without consuming a repair',async()=>{
  const test=await fixture();
  await test.seed();
  let release: (()=>void)|undefined;
  try {
    test.replies.push(test.delegate(),read(),complete(),()=>{
      release=reserveMutation(test.root).release;
      return replan(receipt(test,'read_file')!);
    },input=>{
      expect(review(test)).toEqual([]);
      expect(state(test).frames.at(-2)?.repairs).toBe(0);
      expect(input.messages.at(-1)?.content).toContain('project mutation is active');
      release?.();
      return pass();
    },complete());
    await test.run();
    expect(review(test)).toEqual([expect.objectContaining({disposition:'accepted'})]);
    expect(test.executed).toHaveLength(1);
  } finally { release?.(); }
});

it('rolls back disposition and progress on a review COMMIT failure without replaying effects',async()=>{
  const test=await fixture();
  await test.seed();
  const event=test.store.event.bind(test.store), exec=test.store.db.exec.bind(test.store.db);
  let armed=false, injected=false;
  vi.spyOn(test.store,'event').mockImplementation((chatId,type,data)=>{
    const value=event(chatId,type,data);
    if (type==='review' && !injected) armed=true;
    return value;
  });
  vi.spyOn(test.store.db,'exec').mockImplementation(sql=>{
    if (armed && sql==='COMMIT') {
      armed=false;
      injected=true;
      throw new Error('Fixture review COMMIT veto');
    }
    return exec(sql);
  });
  test.replies.push(test.delegate(),read(),complete(),pass(),input=>{
    expect(input.messages.at(-1)?.content).toContain('Fixture review COMMIT veto');
    expect(state(test).frames.map(frame=>frame.role)).toEqual(['architect','coder','critic']);
    expect(state(test).frames[1].repairs).toBe(0);
    expect(review(test)).toEqual([]);
    expect(step(test).status).toBe('in_progress');
    return {text:'Review halted after veto.',finishReason:'stop'};
  },...Array.from({length:2},()=>({text:'Awaiting review.',finishReason:'stop'})));
  await test.run();
  expect(injected).toBe(true);
  expect(review(test)).toEqual([]);
  expect(test.executed).toHaveLength(1);
  test.store.recover();
  expect(review(test)).toEqual([]);
  expect(test.executed).toHaveLength(1);
});

it('refuses replanning for an uncertain original effect and keeps the no-replay record',async()=>{
  const test=await fixture();
  await test.seed();
  test.commandResults.push({ok:false,output:'Reply lost',data:{uncertain:true}});
  test.replies.push(test.delegate(),call('run_shell',{command:'fixture potential effect'}),complete(),()=>replan(receipt(test,'run_shell')!),pass(),complete());
  await test.run();
  expect(review(test)).toEqual([expect.objectContaining({disposition:'unaccepted',reason:'review_blocked'})]);
  expect(test.executed.map(action=>action.name)).toEqual(['run_shell']);
  expect(step(test).evidence?.summary).toContain('uncertain or interrupted');
});

it('preserves the managed capacity refusal when the Critic schema cannot fit',async()=>{
  const test=await fixture(()=>{});
  test.config.contextLimits.critic=4096;
  await test.seed();
  test.replies.push(test.delegate(),read(),complete());
  await test.run();
  expect(test.requests).toHaveLength(3);
  expect(review(test)).toEqual([]);
  expect(step(test).status).not.toBe('done');
  expect(test.store.messages(test.chat.id).at(-1)?.content).toMatch(/context|capacity/i);
});
