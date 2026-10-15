import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runProbe, LIMITS } from './native-provider-probe.mjs';

const key = 'PRIVATE-KEY-must-never-appear', model = 'explicit-real-catalog-fixture-id';
const frame = (delta, finish = null) => `data: ${JSON.stringify({ model, choices: [{ index: 0, delta, finish_reason: finish }] })}\r\n\r\n`;
const call = { id: 'fixture_call_1', type: 'function', function: { name: 'diagnostic_echo', arguments: '{"value":"M27 harmless echo"}' } };
const reply = (content, calls) => ({ model, choices: [{ message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }] });
async function fixture(fn, override = {}) {
  const requests = []; let endpoint;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    requests.push({ url: req.url, body }); assert.equal(req.headers.authorization, `Bearer ${key}`);
    if (await fn?.({ req, res, body, index: requests.length, endpoint })) return;
    res.setHeader('x-account-id', key); res.setHeader('x-request-id', endpoint + '/private');
    res.setHeader('link', '<https://hostile.invalid/' + key + '>');
    if (!body) { res.end(JSON.stringify({ data: [{ id: model, metadata: key }] })); return; }
    assert.equal(body.model, model); assert.equal(body.max_tokens, LIMITS.tokens);
    const native = Boolean(body.tools), text = body.messages.some(m => m.role === 'tool') ? 'ACK' : 'OK';
    if (text === 'ACK') { const prior = body.messages.at(-2), result = body.messages.at(-1); assert.equal(result.tool_call_id, prior.tool_calls[0].id); assert.deepEqual(JSON.parse(result.content), { value: 'M27 harmless echo' }); }
    if (!body.stream) { res.end(JSON.stringify(reply(native ? '' : text, native ? [call] : undefined))); return; }
    res.setHeader('content-type', 'text/event-stream');
    const data = native ? frame({ tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: 'diagnostic_', arguments: '{"value":' } }] }) + frame({ tool_calls: [{ index: 0, function: { name: 'echo', arguments: '"M27 harmless echo"}' } }] }) + frame({}, 'tool_calls') : frame({ content: text }) + frame({}, 'stop');
    // Deliberately fragment CRLF, JSON and argument bytes across actual HTTP writes.
    for (const char of data + 'data: [DONE]\r\n\r\n') res.write(char);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${server.address().port}/private-endpoint`;
  try {
    const report = await runProbe({ STARK_BASE_URL: endpoint, STARK_API_KEY: key, M27_MODEL: model, M27_SYNTHETIC: '1', ...override });
    const serialized = JSON.stringify(report);
    for (const secret of [key, endpoint, model, 'hostile.invalid', 'diagnostic_echo']) assert(!serialized.includes(secret));
    return { report, requests };
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
test('real synthetic HTTP/SSE: exact catalog, split arguments, correlation and acknowledgement, safe report', async () => {
  const { report, requests } = await fixture(); assert.equal(requests.length, 7);
  for (const name of ['catalog','plain','native','streamingPlain','streamingNative']) assert.equal(report[name].status, 'verified');
  for (const name of ['native','streamingNative']) { assert.equal(report[name].responseIdMatch,'matched'); for (const field of ['argumentsValid','callIdValid','resultCorrelated','acknowledgement']) assert.equal(report[name][field], true); }
});
test('missing exact model never guesses an alias or fans out', async () => {
  const { report, requests } = await fixture(({body,res}) => { if (!body) { res.end('{"data":[{"id":"different-model"}]}'); return true; } });
  assert.equal(report.catalog.status,'missing_model'); assert.equal(requests.length,1);
});
for (const [httpStatus,code,status] of [[429,'anything','rate_gate'],[402,'anything','credit_gate'],[403,'key_locked','key_locked'],[401,'anything','authentication_gate'],[410,'anything','retired'],[400,'tool_not_supported','unsupported']]) {
  test(`safe HTTP ${httpStatus}/${code} classification, no retry`, async () => {
    const {report,requests} = await fixture(({res}) => { res.statusCode = httpStatus; res.end(JSON.stringify({error:{code,message:key+' https://hostile.invalid'}})); return true; });
    assert.equal(report.catalog.status,status); assert.equal(requests.length,1);
  });
}
for (const header of ['retry-after','x-ratelimit-remaining-requests','x-ratelimit-remaining-tokens','x-credits-remaining']) {
  test(`${header} halts further requests without copying hostile values`, async () => {
    const {report,requests} = await fixture(({res}) => { res.setHeader(header, header === 'retry-after' ? 'https://hostile.invalid/'+key : '0'); });
    assert.equal(requests.length,1); assert.equal(report.halted,true); assert.equal(report.native.status,'budget_gate');
  });
}
for (const [name,value,status] of [
  ['prose',reply('I called the tool successfully'),'missing_tool'],
  ['wrong schema',reply('',[{...call,function:{name:'diagnostic_echo',arguments:'{"value":"arbitrary shell"}'}}]),'invalid_arguments'],
  ['duplicate argument',reply('',[{...call,function:{name:'diagnostic_echo',arguments:'{"value":"bad","value":"M27 harmless echo"}'}}]),'malformed'],
  ['hostile tool',reply('',[{...call,function:{name:'run_shell',arguments:'{}'}}]),'malformed'],
  ['bad ID',reply('',[{...call,id:'https://hostile.invalid'}]),'malformed'],
  ['refusal',{choices:[{message:{role:'assistant',refusal:key},finish_reason:'stop'}]},'refused'],
  ['truncation',{choices:[{message:{role:'assistant',content:key},finish_reason:'length'}]},'truncated'],
  ['wrong model',{...reply(''),model:'alias-guessed-by-provider'},'model_mismatch'],
]) test(`native ${name} cannot pass or execute; streaming stays independent`, async () => {
  const {report} = await fixture(({body,res}) => { if (body?.tools && !body.stream) { res.end(JSON.stringify(value)); return true; } });
  assert.equal(report.native.status,status); assert.equal(report.native.resultCorrelated,false); assert.equal(report.streamingNative.status,'verified');
});
test('follow-up tool prose is not acknowledgement', async () => {
  const {report} = await fixture(({body,res}) => { if (body?.messages.some(m=>m.role==='tool') && !body.stream) { res.end(JSON.stringify(reply('I finished '+key))); return true; } });
  assert.equal(report.native.status,'unexpected_reply'); assert.equal(report.native.resultCorrelated,true); assert.equal(report.native.acknowledgement,false);
});
for (const [suffix,status] of [['','truncated'],['data: broken\n\n','malformed'],['event: error\ndata: {}\n\n','transport_failure']]) test(`incomplete/invalid SSE is ${status}`, async () => {
  const {report} = await fixture(({body,res}) => { if (body?.stream) { res.setHeader('content-type','text/event-stream'); res.end(frame({content:key})+suffix); return true; } });
  assert.equal(report.streamingPlain.status,status); assert.equal(report.streamingNative.status,status); assert.equal(report.native.status,'verified');
});
test('response bound fails closed', async () => {
  const {report,requests} = await fixture(({res}) => { res.end('x'.repeat(LIMITS.bytes+1)); return true; });
  assert.equal(report.catalog.status,'response_limit'); assert.equal(requests.length,1);
});
test('redirect is not followed with credentials', async () => {
  let received = 0; const target = http.createServer((req,res)=>{received++;res.end();});
  await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));
  try { const {report,requests}=await fixture(({res})=>{res.writeHead(302,{location:`http://127.0.0.1:${target.address().port}/capture`});res.end();return true;});assert.equal(report.catalog.status,'transport_failure');assert.equal(requests.length,1);assert.equal(received,0); }
  finally {await new Promise(resolve=>target.close(resolve));}
});
test('insecure nonfixture endpoint and missing explicit ID reject without requests', async () => {
  let called = false; for(const env of [{STARK_BASE_URL:'http://provider.invalid',STARK_API_KEY:key,M27_MODEL:model},{STARK_BASE_URL:'https://provider.invalid',STARK_API_KEY:key}]) await assert.rejects(runProbe(env,()=>{called=true;})); assert.equal(called,false);
});
for(const [label,data,status] of [
  ['role',frame({role:'system',content:'OK'})+frame({},'stop')+'data: [DONE]\n\n','malformed'],
  ['index','data: {"choices":[{"index":1,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n','malformed'],
  ['model',frame({content:'OK'})+'data: {"model":"different","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n','model_mismatch'],
  ['finish',frame({content:'OK'},'stop')+frame({content:'more'})+'data: [DONE]\n\n','malformed'],
  ['trailing',frame({content:'OK'},'stop')+'data: [DONE]\n\n'+frame({content:'more'}),'malformed'],
]) test(`conflicting SSE ${label} cannot pass`,async()=>{
  const {report}=await fixture(({body,res})=>{if(body?.stream){res.setHeader('content-type','text/event-stream');res.end(data);return true;}});assert.equal(report.streamingNative.status,status);
});
test('missing response identity stays unknown independently of capability success',async()=>{
  const {report}=await fixture(({body,res})=>{if(body&&!body.stream){const native=Boolean(body.tools),text=body.messages.some(m=>m.role==='tool')?'ACK':'OK';const value=reply(native?'':text,native?[call]:undefined);delete value.model;res.end(JSON.stringify(value));return true;}});
  assert.equal(report.plain.status,'verified');assert.equal(report.native.status,'verified');assert.equal(report.native.responseIdMatch,'unknown');
});
test('follow-up model mismatch fails even after validated correlated arguments',async()=>{
  const {report}=await fixture(({body,res})=>{if(body?.messages.some(m=>m.role==='tool')&&!body.stream){res.end(JSON.stringify({...reply('ACK'),model:'other'}));return true;}});
  assert.equal(report.native.status,'model_mismatch');assert.equal(report.native.argumentsValid,true);assert.equal(report.native.acknowledgement,false);
});
test('catalog entry bound never paginates or starts completion probes',async()=>{
  const {report,requests}=await fixture(({res})=>{res.end(JSON.stringify({data:Array.from({length:1001},()=>({id:model}))}));return true;});assert.equal(report.catalog.status,'malformed');assert.equal(requests.length,1);
});
test('follow-up missing identity does not inherit first response match',async()=>{
  const {report}=await fixture(({body,res})=>{if(body?.messages.some(m=>m.role==='tool')&&!body.stream){const value=reply('ACK');delete value.model;res.end(JSON.stringify(value));return true;}});assert.equal(report.native.status,'verified');assert.equal(report.native.responseIdMatch,'unknown');
});
test('actual stalled response reaches the request deadline without retry or raw error output', {timeout:35000},async()=>{
  const {report,requests}=await fixture(()=>true);assert.equal(report.catalog.status,'timeout');assert.equal(requests.length,1);
});
