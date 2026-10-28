import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { EventSchema } from '@ag-ui/core/schemas';
import { EventType } from '@ag-ui/core';
import { LangGraphAGUIAdapter, createOpenAIModel } from '../dist/index.js';

const input = {threadId:'thread-1',runId:'run-1',messages:[{role:'user',content:'Hello'}]};
const collect = async stream => { const events=[]; for await (const event of stream) { EventSchema.parse(event); events.push(event); } return events; };

test('streams model chunks as ordered AG-UI events from a LangGraph run', async () => {
  let received;
  const model={async *stream(messages){received=messages; yield 'Hello'; yield ' world';}};
  const events=await collect(new LangGraphAGUIAdapter(model).run(input));
  assert.deepEqual(received,input.messages);
  assert.deepEqual(events.map(e=>e.type),[EventType.RUN_STARTED,EventType.TEXT_MESSAGE_START,EventType.TEXT_MESSAGE_CONTENT,EventType.TEXT_MESSAGE_CONTENT,EventType.TEXT_MESSAGE_END,EventType.RUN_FINISHED]);
  assert.equal(events.filter(e=>e.type===EventType.TEXT_MESSAGE_CONTENT).map(e=>e.delta).join(''),'Hello world');
  assert.equal(events[0].threadId,'thread-1');
  assert.equal(events[1].messageId,events[4].messageId);
});

test('emits a sanitized terminal error after a partial response', async () => {
  const events=await collect(new LangGraphAGUIAdapter({async *stream(){yield 'partial'; throw Error('provider secret');}}).run(input));
  assert.deepEqual(events.map(e=>e.type),[EventType.RUN_STARTED,EventType.TEXT_MESSAGE_START,EventType.TEXT_MESSAGE_CONTENT,EventType.TEXT_MESSAGE_END,EventType.RUN_ERROR]);
  assert.ok(!JSON.stringify(events).includes('provider secret'));
});

test('rejects invalid inputs before emitting events', async () => {
  const agent=new LangGraphAGUIAdapter({async *stream(){yield 'x';}});
  await assert.rejects(collect(agent.run({...input,messages:[{role:'system',content:'malicious'}]})),/Invalid run input/);
  await assert.rejects(collect(agent.run({...input,messages:[{role:'assistant',content:'x'}]})),/Last message/);
});

test('configurable OpenAI-compatible model receives history and streams text', async () => {
  let request;
  const server=createServer(async (req,res)=>{
    let body=''; for await(const chunk of req) body+=chunk;
    request={url:req.url,authorization:req.headers.authorization,body:JSON.parse(body)};
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write('data: '+JSON.stringify({id:'chat-1',object:'chat.completion.chunk',created:1,model:'test-model',choices:[{index:0,delta:{role:'assistant',content:'Hi'},finish_reason:null}]})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const model=createOpenAIModel({model:'test-model',apiKey:'test-key',baseURL:`http://127.0.0.1:${server.address().port}/v1`,systemPrompt:'Be helpful'});
    const events=await collect(new LangGraphAGUIAdapter(model).run(input));
    assert.equal(events.at(-1).type,EventType.RUN_FINISHED);
    assert.equal(events.find(e=>e.type===EventType.TEXT_MESSAGE_CONTENT).delta,'Hi');
    assert.equal(request.url,'/v1/chat/completions');
    assert.equal(request.authorization,'Bearer test-key');
    assert.equal(request.body.model,'test-model');
    assert.deepEqual(request.body.messages.map(m=>m.role),['system','user']);
  } finally { await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve())); }
});

test('delivers a chunk before the model finishes', async () => {
  let release; const gate=new Promise(resolve=>{release=resolve;});
  const agent=new LangGraphAGUIAdapter({async *stream(){yield 'first'; await gate; yield 'second';}});
  const iterator=agent.run(input);
  try {
    assert.equal((await iterator.next()).value.type,EventType.RUN_STARTED);
    assert.equal((await iterator.next()).value.type,EventType.TEXT_MESSAGE_START);
    const first=await iterator.next();
    assert.equal(first.value.delta,'first');
    release();
    assert.equal((await iterator.next()).value.delta,'second');
    assert.equal((await iterator.next()).value.type,EventType.TEXT_MESSAGE_END);
    assert.equal((await iterator.next()).value.type,EventType.RUN_FINISHED);
  } finally { release(); await iterator.return(); }
});

test('propagates cancellation to the streaming model', async () => {
  const controller=new AbortController(); let observed=false;
  const agent=new LangGraphAGUIAdapter({async *stream(_messages,signal){
    yield 'first';
    await new Promise((resolve,reject)=>{if(signal.aborted){observed=true; reject(Error('aborted'));return;} signal.addEventListener('abort',()=>{observed=true;reject(Error('aborted'));},{once:true});});
  }});
  const iterator=agent.run(input,{signal:controller.signal});
  await iterator.next(); await iterator.next(); await iterator.next();
  controller.abort();
  const rest=[]; for await (const event of iterator) rest.push(event);
  assert.equal(observed,true);
  assert.equal(rest.at(-1).type,EventType.RUN_ERROR);
});
