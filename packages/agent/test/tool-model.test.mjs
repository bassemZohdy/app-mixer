import test from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage } from '@langchain/core/messages';
import { EventSchema } from '@ag-ui/core/schemas';
import { CapabilityRegistry } from '../../core/dist/index.js';
import {createCapabilityTool,createToolCallingModel,LangGraphAGUIAdapter} from '../dist/index.js';
const input={threadId:'thread',runId:'run',messages:[{role:'user',content:'Find customer'}]};
const collect=async iterable=>{const events=[];for await(const event of iterable){EventSchema.parse(event);events.push(event);}return events;};
function setup(principal='alice'){
  const audit=[],registry=new CapabilityRegistry(e=>audit.push(e));let calls=0;
  registry.register({operationId:'customer',method:'GET',path:'/customer'},{authorize:ctx=>ctx.tenantId==='t'&&ctx.principalId==='alice',validate:input=>input.path?.id==='c1',execute:()=>{calls++;return {name:'Ada'};}});
  const tool=createCapabilityTool({name:'customer',description:'Get customer',invoke:args=>registry.invoke('customer',args,{tenantId:'t',principalId:principal,origin:'agent'})});
  return {audit,tool,calls:()=>calls};
}

test('LangGraph agent executes an explicitly configured capability and emits final AG-UI text',async()=>{
  const {tool,calls,audit}=setup();let turn=0;
  const model={async invoke(messages){turn++;if(turn===1)return new AIMessage({content:'',tool_calls:[{id:'call-1',name:'customer',args:{path:{id:'c1'}}}]});assert.equal(messages.at(-1)._getType(),'tool');assert.match(messages.at(-1).content,/Ada/);return new AIMessage('Customer is Ada');}};
  const agent=new LangGraphAGUIAdapter(createToolCallingModel(model,[tool]));
  const events=await collect(agent.run(input));
  assert.equal(events.at(-1).type,'RUN_FINISHED');assert.equal(events.find(e=>e.type==='TEXT_MESSAGE_CONTENT').delta,'Customer is Ada');
  assert.equal(calls(),1);assert.deepEqual(audit.map(e=>e.outcome),['attempt','succeeded']);
});

test('denied and unregistered tools fail without invoking the upstream capability',async()=>{
  for(const mode of ['denied','unknown']){
    const {tool,calls}=setup(mode==='denied'?'bob':'alice');
    const model={async invoke(){return new AIMessage({content:'',tool_calls:[{id:'call-1',name:mode==='unknown'?'unregistered':'customer',args:{path:{id:'c1'}}}]});}};
    const events=await collect(new LangGraphAGUIAdapter(createToolCallingModel(model,[tool])).run(input));
    assert.equal(events.at(-1).type,'RUN_ERROR');assert.equal(calls(),0);
  }
});

test('turn limit stops before executing a tool when no model turn remains',async()=>{
  const {tool,calls}=setup();
  const model={async invoke(){return new AIMessage({content:'',tool_calls:[{id:'c',name:'customer',args:{path:{id:'c1'}}}]});}};
  const events=await collect(new LangGraphAGUIAdapter(createToolCallingModel(model,[tool],{maxTurns:1})).run(input));
  assert.equal(events.at(-1).type,'RUN_ERROR');assert.equal(calls(),0);
});

test('configured OpenAI-compatible model performs a bounded tool round-trip',async()=>{
  const {createServer}=await import('node:http');const {once}=await import('node:events');
  const {createOpenAIToolModel}=await import('../dist/index.js');let requests=[];
  const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
    const message=requests.length===1?{role:'assistant',content:null,tool_calls:[{id:'call-1',type:'function',function:{name:'customer',arguments:'{"path":{"id":"c1"}}'}}]}:{role:'assistant',content:'Customer is Ada'};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'completion',object:'chat.completion',created:1,model:'test-model',choices:[{index:0,message,finish_reason:requests.length===1?'tool_calls':'stop'}]}));
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const {tool,calls}=setup();const model=createOpenAIToolModel({model:'test-model',apiKey:'test-key',systemPrompt:'Trusted instruction',baseURL:`http://127.0.0.1:${server.address().port}/v1`},[tool]);
    const events=await collect(new LangGraphAGUIAdapter(createToolCallingModel(model,[tool])).run(input));
    assert.equal(events.at(-1).type,'RUN_FINISHED');assert.equal(events.find(e=>e.type==='TEXT_MESSAGE_CONTENT').delta,'Customer is Ada');
    assert.equal(calls(),1);assert.equal(requests.length,2);assert.equal(requests[0].tools[0].function.name,'customer');assert.equal(requests[0].messages[0].role,'system');assert.equal(requests[0].messages[0].content,'Trusted instruction');
    assert.ok(requests[1].messages.some(message=>message.role==='tool'));
  }finally{await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
