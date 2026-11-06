import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createAgentApprovalServer} from '../dist/index.js';
import {AgentError,agentErrorStatus} from '../dist/errors.js';

test('agent refusals carry a code and map to one status; documented legacy messages keep theirs',()=>{
 const cause=new Error('detail'),error=new AgentError('conflict','Approval already decided',{cause});
 assert.ok(error instanceof Error);assert.equal(error.name,'AgentError');assert.equal(error.code,'conflict');assert.equal(error.cause,cause);
 assert.deepEqual(['invalid','denied','not_found','conflict','limit','lost_race'].map(code=>agentErrorStatus(new AgentError(code,'x'))),[400,403,404,409,429,409]);
 assert.equal(agentErrorStatus(new Error('Approval not found')),404,'a host store that still throws the documented message keeps its status');
 for(const other of [new Error('Approval was not found'),new Error('constructor'),new Error('__proto__'),'text',null,undefined])assert.equal(agentErrorStatus(other),undefined);
});

test('every AgentError thrown in the agent package uses a code that maps to a status',()=>{
 const dir=fileURLToPath(new URL('../src/',import.meta.url));let sites=0;
 for(const name of readdirSync(dir).filter(file=>file.endsWith('.ts')))for(const match of readFileSync(join(dir,name),'utf8').matchAll(/new AgentError\('([a-z_]+)'/g)){sites++;assert.notEqual(agentErrorStatus(new AgentError(match[1],'x')),undefined,`${name}: unknown code ${match[1]}`);}
 assert.ok(sites>=30,'the mapped refusals are thrown as AgentError ('+sites+' sites)');
});

test('the approval server answers with the status of an error code, a fixed text and never the message',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{SqliteAgentRuns,SqliteAgentApprovals}=await import('../dist/index.js');
 const dir=mkdtempSync(join(tmpdir(),'errors-review-')),path=join(dir,'db'),scope={tenantId:'tenant',agentId:'agent'},runs=new SqliteAgentRuns(path);
 const approvals=new SqliteAgentApprovals(path,{scope,runId:'run',clock:()=>10,authorize:()=>true});let failure;approvals.decide=async()=>{throw failure;};
 runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline:1000},0);
 const server=createAgentApprovalServer({authenticate:()=>({tenantId:'tenant',principalId:'reviewer'}),resolve:()=>approvals});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`,post=()=>fetch(base+'/api/agents/agent/runs/run/approvals/action/decision',{method:'POST',headers:{authorization:'Bearer x',origin:base,'content-type':'application/json'},body:JSON.stringify({decision:'approved'})});
 try{
  for(const [error,status,text] of [[new AgentError('denied','private detail'),403,'Forbidden'],[new AgentError('not_found','private detail'),404,'Not found'],[new AgentError('conflict','private detail'),409,'Decision unavailable'],[new Error('Approval expired'),409,'Decision unavailable'],[new AgentError('limit','private detail'),500,'Review unavailable'],[new Error('database exploded: secret'),500,'Review unavailable']]){
   failure=error;const response=await post(),body=await response.json();assert.equal(response.status,status,String(error.message));assert.equal(body.error,text);assert.doesNotMatch(JSON.stringify(body),/private detail|secret/);
  }
 }finally{server.closeAllConnections();server.close();approvals.close();runs.close();rmSync(dir,{recursive:true,force:true});}
});

test('the run supervisor ignores lost races by error code, whatever the message says, and reports everything else',async()=>{
 const {PostgresRunSupervisor}=await import('../dist/index.js');
 const reported=[];let failure;
 const runs={claim:async()=>{},expiredLeases:async()=>[{runId:'r1',revision:1}],recoverExpired:async()=>{throw failure;},uncertain:async()=>[],queued:async()=>[]};
 const supervisor=new PostgresRunSupervisor({runs,scope:{tenantId:'t',agentId:'a'},workerId:'w',execute:async()=>'succeeded',verify:async()=>({outcome:'unknown'}),onError:error=>reported.push(error)});
 for(const lost of [new AgentError('lost_race','The lease moved to another node'),new AgentError('lost_race','anything at all')]){failure=lost;await supervisor.runOnce();}
 assert.deepEqual(reported,[],'a lost race is routine');
 const other=new AgentError('conflict','Run revision conflict'),plain=new Error('Run revision conflict');
 for(const error of [other,plain,new Error('database down')]){failure=error;await supervisor.runOnce();}
 assert.equal(reported.length,3,'only lost_race errors are ignored: reworded or look-alike messages are not');
});
