import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {AIMessage,HumanMessage} from '@langchain/core/messages';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {SqliteAgentRuns,SqliteAgentDefinitions,SqliteAgentTokenBudget,SqliteAgentApprovals,SqliteAgentDelegations,SqliteAgentActionJournal,createConfiguredAgentRun,createOpenAILimitedToolModel,hadNoEffect} from '../dist/index.js';
const scope={tenantId:'t',agentId:'agent'},manifest={manifestVersion:1,tenantId:'t',agentId:'agent',name:'Agent',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'service',model:{provider:'local',model:'test'},allowedCapabilities:[],lifecycle:{enabled:true,maxAttempts:3,runTimeoutMs:10000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:10}};
function setup(){const dir=mkdtempSync(join(tmpdir(),'agent-budget-')),path=join(dir,'db'),runs=new SqliteAgentRuns(path),definitions=new SqliteAgentDefinitions(':memory:');let now=10;definitions.save('t',manifest,0);let run=runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline:1000},0);run=runs.claim(scope,'run',run.revision,'worker',100,now);const budget=new SqliteAgentTokenBudget(path,{scope,runId:'run',leaseToken:run.leaseToken,maxTokens:100,clock:()=>now});return {dir,path,runs,definitions,budget,get run(){return run},set run(value){run=value},set now(value){now=value}};}
function close(s){s.budget.close();s.runs.close();s.definitions.close();rmSync(s.dir,{recursive:true,force:true})}
const input={threadId:'thread',runId:'run',messages:[{role:'user',content:'Hello'}]};
async function modelRun(s,model,extra={}){const agent=await createConfiguredAgentRun({definitions:s.definitions,tenantId:'t',agentId:'agent',expectedVersion:1,bindings:[],registry:{invoke:async()=>null},authorizeRun:()=>true,authorizeCapability:()=>true,tokenBudget:{budget:s.budget,maxTokensPerCall:60},createModel:()=>model,...extra});const events=[];for await(const event of agent.run(input))events.push(event);return events.at(-1);}

test('cost and token reservations are atomic, scoped and pinned across connections',()=>{const s=setup();let cost,other,wrong;try{const config={scope,runId:'run',leaseToken:s.run.leaseToken,maxTokens:100,cost:{currency:'USD',maxMicros:1000},clock:()=>10};cost=new SqliteAgentTokenBudget(s.path,config);other=new SqliteAgentTokenBudget(s.path,config);cost.reserve('first',40,600);assert.deepEqual(other.costSummary(),{currency:'USD',limit:1000,committed:0,reserved:600});assert.throws(()=>other.reserve('too-costly',20,401),/Cost budget exhausted/);assert.equal(other.get('too-costly'),undefined);assert.throws(()=>s.budget.reserve('no-cost',1),/Cost budget conflict/);wrong=new SqliteAgentTokenBudget(s.path,{...config,cost:{currency:'EUR',maxMicros:1000}});assert.throws(()=>wrong.reserve('wrong',1,1),/Cost budget conflict/);cost.settle('first',20,300);other.reserve('second',40,600);assert.deepEqual(cost.costSummary(),{currency:'USD',limit:1000,committed:300,reserved:600});assert.deepEqual(cost.summary(),{limit:100,committed:20,reserved:40});assert.throws(()=>other.settle('second',10),/Invalid cost usage/);assert.equal(other.get('second').status,'reserved');other.settle('second',10,700);assert.throws(()=>cost.reserve('third',1,1),/Cost provider limit violated/);}finally{cost?.close();other?.close();wrong?.close();close(s)}});

test('cost budget cannot be added after unpriced calls',()=>{const s=setup();let cost;try{s.budget.reserve('old',10);s.budget.settle('old',2);cost=new SqliteAgentTokenBudget(s.path,{scope,runId:'run',leaseToken:s.run.leaseToken,maxTokens:100,cost:{currency:'USD',maxMicros:1000},clock:()=>10});assert.throws(()=>cost.reserve('new',10,10),/after token calls/);assert.equal(cost.get('new'),undefined);}finally{cost?.close();close(s)}});

test('combined reservations and settlements roll back together on storage failure',()=>{const s=setup();let cost,db;try{cost=new SqliteAgentTokenBudget(s.path,{scope,runId:'run',leaseToken:s.run.leaseToken,maxTokens:100,cost:{currency:'USD',maxMicros:1000},clock:()=>10});db=new DatabaseSync(s.path);db.exec("CREATE TRIGGER reject_token_insert BEFORE INSERT ON agent_token_calls BEGIN SELECT RAISE(ABORT,'token insert failed'); END");assert.throws(()=>cost.reserve('one',30,300),/token insert failed/);assert.equal(cost.getCost('one'),undefined);assert.equal(cost.get('one'),undefined);db.exec('DROP TRIGGER reject_token_insert');cost.reserve('one',30,300);db.exec("CREATE TRIGGER reject_token_settle BEFORE UPDATE ON agent_token_calls BEGIN SELECT RAISE(ABORT,'token update failed'); END");assert.throws(()=>cost.settle('one',10,100),/token update failed/);assert.equal(cost.getCost('one').status,'reserved');assert.equal(cost.get('one').status,'reserved');}finally{db?.close();cost?.close();close(s)}});

test('cost-limited model accounts for verified usage and rejects overrun',async()=>{for(const over of [false,true]){const s=setup();let cost;try{cost=new SqliteAgentTokenBudget(s.path,{scope,runId:'run',leaseToken:s.run.leaseToken,maxTokens:100,cost:{currency:'USD',maxMicros:1000},clock:()=>10});const model={invoke:async()=>new AIMessage('unused'),invokeLimitedCost:async(_messages,opts)=>{assert.equal(opts.currency,'USD');assert.equal(opts.maxCostMicros,600);assert.equal(opts.maxTotalTokens,60);assert.equal(cost.costSummary().reserved,600);return {message:new AIMessage('Done'),usedTokens:20,usedCostMicros:over?700:300}}};const result=await modelRun(s,model,{tokenBudget:{budget:cost,maxTokensPerCall:60,maxCostMicrosPerCall:600}});assert.equal(result.type,over?'RUN_ERROR':'RUN_FINISHED');assert.deepEqual(cost.costSummary(),{currency:'USD',limit:1000,committed:over?700:300,reserved:0});if(over)assert.throws(()=>cost.reserve('later',1,1),/Cost provider limit violated/);}finally{cost?.close();close(s)}}});

test('ambiguous cost usage holds both reservations until explicit reconciliation',async()=>{const s=setup();let cost;try{cost=new SqliteAgentTokenBudget(s.path,{scope,runId:'run',leaseToken:s.run.leaseToken,maxTokens:100,cost:{currency:'USD',maxMicros:1000},clock:()=>10});const model={invoke:async()=>new AIMessage('unused'),invokeLimitedCost:async()=>({message:new AIMessage('Done'),usedTokens:10})};assert.equal((await modelRun(s,model,{tokenBudget:{budget:cost,maxTokensPerCall:60,maxCostMicrosPerCall:600}})).type,'RUN_ERROR');const call=cost.list()[0];assert.equal(call.status,'reserved');assert.equal(cost.costSummary().reserved,600);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'succeeded',11);assert.equal(s.run.status,'uncertain');assert.throws(()=>s.runs.reconcile(scope,'run',s.run.revision,'retry',12),/Token usage/);assert.throws(()=>cost.reconcile(call.callId,10),/Invalid cost usage/);assert.equal(cost.get(call.callId).status,'reserved');cost.reconcile(call.callId,10,200);assert.equal(s.runs.reconcile(scope,'run',s.run.revision,'retry',12).status,'queued');assert.equal(cost.costSummary().committed,200);}finally{cost?.close();close(s)}});

test('cost budgets require a cost-limited model and retain per-call cost evidence',async()=>{const s=setup();let cost;try{cost=new SqliteAgentTokenBudget(s.path,{scope,runId:'run',leaseToken:s.run.leaseToken,maxTokens:100,cost:{currency:'USD',maxMicros:1000},clock:()=>10});const tokenOnly={invoke:async()=>new AIMessage('unused'),invokeLimited:async()=>({message:new AIMessage('Done'),usedTokens:1})};await assert.rejects(modelRun(s,tokenOnly,{tokenBudget:{budget:cost,maxTokensPerCall:60,maxCostMicrosPerCall:600}}),/Limited model required/);await assert.rejects(modelRun(s,tokenOnly,{tokenBudget:{budget:cost,maxTokensPerCall:60}}),/Invalid token budget/);cost.reserve('call',40,500);assert.deepEqual(cost.getCost('call'),{callId:'call',currency:'USD',reserved:500,used:null,status:'reserved'});cost.settle('call',12,180);assert.deepEqual(cost.getCost('call'),{callId:'call',currency:'USD',reserved:500,used:180,status:'settled'});}finally{cost?.close();close(s)}});

test('reservations enforce limits atomically across connections and persist through restart',()=>{const s=setup();let other;try{other=new SqliteAgentTokenBudget(s.path,{scope,runId:'run',leaseToken:s.run.leaseToken,maxTokens:100,clock:()=>10});s.budget.reserve('one',60);assert.throws(()=>other.reserve('two',50),/exhausted/);assert.deepEqual(other.summary(),{limit:100,committed:0,reserved:60});s.budget.settle('one',35);other.reserve('two',60);assert.deepEqual(s.budget.summary(),{limit:100,committed:35,reserved:60});assert.throws(()=>other.reserve('one',1),/already exists/);other.close();other=new SqliteAgentTokenBudget(s.path,{scope,runId:'run',leaseToken:s.run.leaseToken,maxTokens:100,clock:()=>10});assert.deepEqual(other.list().map(x=>x.callId),['one','two']);}finally{other?.close();close(s)}});

test('configured runtime reserves a provider-enforced limit and records reported usage',async()=>{const s=setup();try{let calls=0;const model={invoke:async()=>{throw Error('unlimited invocation')},invokeLimited:async(_messages,{maxTotalTokens,callId})=>{calls++;assert.equal(maxTotalTokens,60);assert.equal(s.budget.get(callId).reserved,60);return {message:new AIMessage('Done'),usedTokens:42}}};assert.equal((await modelRun(s,model)).type,'RUN_FINISHED');assert.equal(calls,1);assert.deepEqual(s.budget.summary(),{limit:100,committed:42,reserved:0});assert.equal(s.budget.list()[0].used,42);}finally{close(s)}});

test('failed or invalid provider usage stays reserved until uncertain-run reconciliation',async()=>{for(const mode of ['failure','invalid']){const s=setup();let next;try{const model={invoke:async()=>new AIMessage('unused'),invokeLimited:async()=>{if(mode==='failure')throw Error('provider failed');return {message:new AIMessage('Done'),usedTokens:undefined}}};assert.equal((await modelRun(s,model)).type,'RUN_ERROR');const call=s.budget.list()[0];assert.equal(call.status,'reserved');assert.deepEqual(s.budget.summary(),{limit:100,committed:0,reserved:60});assert.throws(()=>s.budget.reconcile(call.callId,20),/not uncertain/);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'uncertain',20);s.budget.reconcile(call.callId,20);s.run=s.runs.reconcile(scope,'run',s.run.revision,'retry',21);s.run=s.runs.claim(scope,'run',s.run.revision,'new-worker',100,22);next=new SqliteAgentTokenBudget(s.path,{scope,runId:'run',leaseToken:s.run.leaseToken,maxTokens:100,clock:()=>23});next.reserve('next',60);assert.deepEqual(next.summary(),{limit:100,committed:20,reserved:60});}finally{next?.close();close(s)}}});

test('stale leases, mismatched run limits, and provider overuse fail closed',async()=>{const s=setup();let wrong;try{wrong=new SqliteAgentTokenBudget(s.path,{scope,runId:'run',leaseToken:s.run.leaseToken,maxTokens:99,clock:()=>10});const model={invoke:async()=>new AIMessage('unused'),invokeLimited:async()=>({message:new AIMessage('Done'),usedTokens:70})};await assert.rejects(modelRun(s,model,{tokenBudget:{budget:wrong,maxTokensPerCall:60}}),/mismatch/);assert.equal((await modelRun(s,model)).type,'RUN_ERROR');assert.deepEqual(s.budget.summary(),{limit:100,committed:70,reserved:0});assert.throws(()=>s.budget.reserve('next',31),/limit violated/);s.now=110;assert.throws(()=>s.budget.settle('missing',1),/lease unavailable/);assert.throws(()=>s.budget.reserve('stale',1),/lease unavailable/);}finally{wrong?.close();close(s)}});

test('runtime requires a limited provider adapter for an opted-in budget',async()=>{const s=setup();try{await assert.rejects(modelRun(s,{invoke:async()=>new AIMessage('Done')}),/Limited model required/);assert.deepEqual(s.budget.summary(),{limit:100,committed:0,reserved:0});}finally{close(s)}});

test('lease loss during a provider call keeps the full reservation for reconciliation',async()=>{const s=setup();try{let started,release;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);const model={invoke:async()=>new AIMessage('unused'),invokeLimited:async()=>{started();await gate;return {message:new AIMessage('Done'),usedTokens:10}}};const pending=modelRun(s,model);await ready;s.now=110;s.run=s.runs.recoverExpired(scope,'run',s.run.revision,110);release();assert.equal((await pending).type,'RUN_ERROR');assert.deepEqual(s.budget.summary(),{limit:100,committed:0,reserved:60});const call=s.budget.list()[0];assert.equal(s.budget.reconcile(call.callId,10).used,10);}finally{close(s)}});

test('a run budget cannot be replaced by mutating the options during model construction',async()=>{const s=setup();let wrong;try{wrong=new SqliteAgentTokenBudget(s.path,{scope,runId:'run',leaseToken:s.run.leaseToken,maxTokens:99,clock:()=>10});const options={budget:s.budget,maxTokensPerCall:60},model={invoke:async()=>new AIMessage('unused'),invokeLimited:async()=>({message:new AIMessage('Done'),usedTokens:20})};assert.equal((await modelRun(s,model,{tokenBudget:options,createModel:()=>{options.budget=wrong;options.maxTokensPerCall=1;return model}})).type,'RUN_FINISHED');assert.equal(s.budget.summary().committed,20);}finally{wrong?.close();close(s)}});

test('unresolved token reservations force uncertain outcomes and prevent premature reconciliation',()=>{
 for(const outcome of ['succeeded','failed','stopped','uncertain']){const s=setup();try{s.budget.reserve('first',30);s.budget.reserve('second',30);if(outcome==='stopped')s.run=s.runs.request(scope,'run',s.run.revision,'pause',11);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,outcome,12);assert.equal(s.run.status,'uncertain');for(const decision of ['retry','succeeded','failed','cancelled','paused'])assert.throws(()=>s.runs.reconcile(scope,'run',s.run.revision,decision,13),/Token usage requires reconciliation/);assert.equal(s.runs.get(scope,'run').revision,s.run.revision);s.budget.reconcile('first',20);assert.throws(()=>s.runs.reconcile(scope,'run',s.run.revision,'retry',13),/Token usage requires reconciliation/);s.budget.reconcile('second',10);s.run=s.runs.reconcile(scope,'run',s.run.revision,'retry',13);assert.equal(s.run.status,'queued');}finally{close(s)}}
});

test('token reservation recovery gates are scoped to the run and survive registry reopening',()=>{const s=setup();let reopened;try{s.budget.reserve('first',30);s.run=s.runs.settle(scope,'run',s.run.revision,s.run.leaseToken,'failed',12);const otherScope={tenantId:'other',agentId:'agent'};let other=s.runs.create(otherScope,'run',{definitionVersion:1,maxAttempts:2,deadline:1000},0);other=s.runs.claim(otherScope,'run',other.revision,'worker',100,10);other=s.runs.settle(otherScope,'run',other.revision,other.leaseToken,'succeeded',12);assert.equal(other.status,'succeeded');reopened=new SqliteAgentRuns(s.path);assert.throws(()=>reopened.reconcile(scope,'run',s.run.revision,'failed',13),/Token usage requires reconciliation/);s.budget.reconcile('first',18);assert.equal(reopened.reconcile(scope,'run',s.run.revision,'failed',13).status,'failed');}finally{reopened?.close();close(s)}});

test('approval and delegation waits reject unresolved token usage',async()=>{const s=setup();let journal,approvals,delegations;try{journal=new SqliteAgentActionJournal(s.path,{scope,runId:'run',leaseToken:s.run.leaseToken,clock:()=>10});approvals=new SqliteAgentApprovals(s.path,{scope,runId:'run',clock:()=>10,authorize:()=>true});delegations=new SqliteAgentDelegations(s.path,{scope,runId:'run',clock:()=>10,authorize:()=>true});await approvals.request({tenantId:'t',principalId:'service'},s.run.leaseToken,'action','pay',{},90);const grant=(await delegations.issue({tenantId:'t',principalId:'admin'},{...scope,runId:'run',grantId:'grant',principalId:'user',permissionVersion:'v1',expiresAt:20})).grant;s.budget.reserve('call',30);assert.throws(()=>s.runs.pauseForApproval(scope,'run',s.run.revision,s.run.leaseToken,'action',10),/Token usage requires reconciliation/);assert.throws(()=>s.runs.pauseForDelegation(scope,'run',s.run.revision,s.run.leaseToken,'grant',grant.revision,20),/Token usage requires reconciliation/);assert.equal(s.runs.get(scope,'run').status,'running');s.budget.settle('call',10);assert.equal(s.runs.pauseForApproval(scope,'run',s.run.revision,s.run.leaseToken,'action',20).status,'paused');}finally{delegations?.close();approvals?.close();journal?.close();close(s)}});

// A stand-in for an OpenAI-compatible provider. It records each request and answers with the usage it is told to report.
async function provider(answer){
  const requests=[],server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
    const reply=await answer(body,requests.length);
    if(reply.status){res.writeHead(reply.status,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'provider failed'}}));return;}
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({id:'c',object:'chat.completion',created:1,model:'m',choices:[{index:0,message:{role:'assistant',content:reply.content??'Done'},finish_reason:'stop'}],...(reply.usage?{usage:reply.usage}:{})}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {requests,baseURL:`http://127.0.0.1:${server.address().port}/v1`,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
const config=baseURL=>({model:'m',apiKey:'key',baseURL});

test('the OpenAI-compatible limited model caps the provider output, reports provider usage and does not retry',async()=>{
  const ok=await provider(()=>({usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}})),failing=await provider(()=>({status:500}));
  try{
    const model=createOpenAILimitedToolModel(config(ok.baseURL),[],{promptOverheadTokens:0});
    const result=await model.invokeLimited([new HumanMessage('Hello')],{maxTotalTokens:60,callId:'call'});
    assert.equal(result.usedTokens,20);assert.equal(result.message.content,'Done');
    assert.equal(ok.requests.length,1);
    // 60 tokens minus the bound for the prompt: 16 for the message, 5 bytes of text and 5 for its type.
    assert.equal(ok.requests[0].max_tokens,60-16-5-5);
    const broken=createOpenAILimitedToolModel(config(failing.baseURL),[],{promptOverheadTokens:0});
    await assert.rejects(broken.invokeLimited([new HumanMessage('Hello')],{maxTotalTokens:60,callId:'call'}));
    assert.equal(failing.requests.length,1,'a failed call is not retried');
  }finally{await ok.close();await failing.close();}
});

test('a prompt that cannot fit is refused before anything is sent, and a response without usage is an error',async()=>{
  const noUsage=await provider(()=>({})),quiet=await provider(()=>({usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
  try{
    const model=createOpenAILimitedToolModel(config(quiet.baseURL),[]);
    const refusal=await model.invokeLimited([new HumanMessage('x'.repeat(100))],{maxTotalTokens:50,callId:'call'}).catch(error=>error);
    assert.match(refusal.message,/does not fit/);assert.equal(hadNoEffect(refusal),true);assert.equal(quiet.requests.length,0);
    await assert.rejects(model.invokeLimited([new HumanMessage('Hi')],{maxTotalTokens:0,callId:'call'}),/Invalid token limit/);
    const silent=createOpenAILimitedToolModel(config(noUsage.baseURL),[],{promptOverheadTokens:0});
    const missing=await silent.invokeLimited([new HumanMessage('Hello')],{maxTotalTokens:200,callId:'call'}).catch(error=>error);
    assert.match(missing.message,/did not report token usage/);assert.equal(hadNoEffect(missing),false,'the request was sent, so the reservation must be reconciled');
    assert.equal(noUsage.requests.length,1);
  }finally{await noUsage.close();await quiet.close()}
});

test('the OpenAI-compatible limited model bounds cost before dispatch and prices the reported usage',async()=>{
  const server=await provider(()=>({usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}}));
  try{
    // One micro per input token and two per output token.
    const pricing={currency:'USD',inputMicrosPerMillionTokens:1000000,outputMicrosPerMillionTokens:2000000};
    const model=createOpenAILimitedToolModel(config(server.baseURL),[],{pricing,promptOverheadTokens:0});
    const result=await model.invokeLimitedCost([new HumanMessage('Hello')],{maxTotalTokens:1000,maxCostMicros:100,currency:'USD',callId:'call'});
    assert.equal(result.usedTokens,150);assert.equal(result.usedCostMicros,100*1+50*2);
    // The prompt bound is 26 tokens, which costs 26; the remaining 74 micros buy 37 output tokens, fewer than the token limit allows.
    assert.equal(server.requests[0].max_tokens,37);
    await assert.rejects(model.invokeLimitedCost([new HumanMessage('Hello')],{maxTotalTokens:1000,maxCostMicros:20,currency:'USD',callId:'call'}),/does not fit the cost limit/);
    await assert.rejects(model.invokeLimitedCost([new HumanMessage('Hello')],{maxTotalTokens:1000,maxCostMicros:100,currency:'EUR',callId:'call'}),/Currency does not match/);
    assert.equal(server.requests.length,1);
    assert.equal(typeof createOpenAILimitedToolModel(config(server.baseURL),[]).invokeLimitedCost,'undefined');
    assert.throws(()=>createOpenAILimitedToolModel(config(server.baseURL),[],{pricing:{...pricing,outputMicrosPerMillionTokens:0}}),/Invalid pricing/);
  }finally{await server.close()}
});

test('a runtime with a token budget settles a provider call and releases a reservation the model refused to send',async()=>{
  const s=setup(),server=await provider(()=>({usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}}));
  try{
    const model=createOpenAILimitedToolModel(config(server.baseURL),[],{promptOverheadTokens:0});
    assert.equal((await modelRun(s,model)).type,'RUN_FINISHED');
    assert.deepEqual(s.budget.summary(),{limit:100,committed:20,reserved:0});assert.equal(server.requests[0].max_tokens,60-26);
    // A prompt larger than the per-call limit is refused before dispatch: the reservation is released, not left uncertain.
    const refused=createOpenAILimitedToolModel(config(server.baseURL),[],{promptOverheadTokens:100});
    assert.equal((await modelRun(s,refused)).type,'RUN_ERROR');
    assert.deepEqual(s.budget.summary(),{limit:100,committed:20,reserved:0});assert.equal(server.requests.length,1);
    assert.equal(s.budget.list().at(-1).status,'settled');
  }finally{await server.close();close(s)}
});
