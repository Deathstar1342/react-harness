// Controlled hook lifecycle tests, not a claim of real-browser interaction.
import { afterEach, expect, it, vi } from 'vitest';
const hooks=vi.hoisted(()=>({effects:[] as (()=>void|(()=>void))[]}));
vi.mock('react',()=>({
  useState:(initial:unknown)=>[initial,vi.fn()],useRef:(current:unknown)=>({current}),
  useEffect:(effect:()=>void|(()=>void))=>hooks.effects.push(effect),
}));
import { useConversation } from '../client/useConversation';
class Source extends EventTarget {
  static CLOSED=2;
  static instances:Source[]=[];
  readyState=1;onerror?:()=>void;onopen?:()=>void;
  close=vi.fn(()=>{this.readyState=Source.CLOSED;});
  constructor(readonly url:string){super();Source.instances.push(this);}
}
let dispose:(()=>void)|undefined;
afterEach(()=>{dispose?.();dispose=undefined;hooks.effects=[];Source.instances=[];vi.useRealTimers();vi.unstubAllGlobals();});
function setup(status=200) {
  vi.useFakeTimers();vi.stubGlobal('EventSource',Source);
  const fetcher=vi.fn().mockImplementation(async()=>new Response(JSON.stringify(status===404 ? {error:'Chat not found'} : {events:[],messages:[],chat:{id:'chat'}}),{status}));
  vi.stubGlobal('fetch',fetcher);
  const changed=vi.fn(),conversation=useConversation('chat',changed);
  dispose=hooks.effects[0]() || undefined;return {fetcher,changed,conversation};
}
it('terminal removal closes the stream and clears queued refresh/polling work',async()=>{
  const t=setup();await vi.advanceTimersByTimeAsync(0);const source=Source.instances[0];
  source.dispatchEvent(new MessageEvent('file_changed',{data:'{}',lastEventId:'1'}));
  source.dispatchEvent(new MessageEvent('chat_removed',{data:'{}'}));
  expect(source.close).toHaveBeenCalledOnce();expect(t.changed).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);await t.conversation.refresh();expect(t.fetcher).toHaveBeenCalledOnce();expect(Source.instances).toHaveLength(1);
});
it('a missed removal event ends retries on the first authoritative 404',async()=>{
  const t=setup();await vi.advanceTimersByTimeAsync(0);
  t.fetcher.mockImplementation(async()=>new Response(JSON.stringify({error:'Chat not found'}),{status:404}));
  Source.instances[0].onerror?.();await vi.advanceTimersByTimeAsync(0);
  expect(Source.instances[0].close).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(60_000);expect(t.fetcher).toHaveBeenCalledTimes(2);
});
it('an initially missing chat does not keep polling or open a stream',async()=>{
  const t=setup(404);await vi.advanceTimersByTimeAsync(60_000);expect(t.fetcher).toHaveBeenCalledOnce();expect(Source.instances).toHaveLength(0);
});
it('ordinary transport failures retain reconnection behavior',async()=>{
  const t=setup(503);await vi.advanceTimersByTimeAsync(30_001);expect(t.fetcher.mock.calls.length).toBeGreaterThan(1);
});
