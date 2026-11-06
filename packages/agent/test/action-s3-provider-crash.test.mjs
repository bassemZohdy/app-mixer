// A worker process dispatching a journaled action to a real S3 provider is killed before the write, after the
// provider applied it but before the response arrived, or after the result was recorded. Recovery reconciles
// against the provider and the order exists exactly once. Opt-in: APP_MIXER_TEST_S3=docker (SeaweedFS in Docker).
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteAgentRuns,SqliteAgentActionJournal,checkIdempotencyContract} from '../dist/index.js';
import {startS3Provider,faultyProxy,putOnce,sleep} from '../../core/test/fixtures/s3-provider.mjs';

const enabled=process.env.APP_MIXER_TEST_S3==='docker',bucket='agent-actions',settleMs=2000;
const scope={tenantId:'tenant',agentId:'agent'},workerPath=fileURLToPath(new URL('./fixtures/crash-s3-action-worker.mjs',import.meta.url));
const input={sku:'A-1',quantity:2};

test('journaled actions killed mid-dispatch reconcile against a real S3 provider without a duplicate effect',{skip:!enabled&&'set APP_MIXER_TEST_S3=docker to run against a SeaweedFS container',timeout:400000},async()=>{
 let provider,proxy;
 try{
  provider=await startS3Provider(bucket);proxy=await faultyProxy(provider.port);
  const path=key=>provider.objectPath('orders/'+key);
  // Applied needs the stored order to match the journaled input. Not applied needs no object, a dead submitter and a
  // settle period longer than the provider takes to process a request it has received.
  const verifier=diedAt=>async request=>{
   const found=await provider.request({method:'GET',path:path(request.action.idempotencyKey)});
   if(found.status===200)return JSON.stringify(JSON.parse(found.body))===JSON.stringify(request.input)?{outcome:'applied',result:{receipt:'orders/'+request.action.idempotencyKey,created:true}}:{outcome:'unknown'};
   if(found.status===404&&Date.now()-diedAt>=settleMs)return {outcome:'not_applied'};
   return {outcome:'unknown'};
  };

  for(const mode of ['before','after','recorded']){
   const dir=mkdtempSync(join(tmpdir(),'agent-s3-crash-')),dbPath=join(dir,'runs.sqlite');let runs,journal,recovered,child;
   try{
    runs=new SqliteAgentRuns(dbPath);runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline:10000},0);runs.close();runs=undefined;
    proxy.state.mode=mode==='after'?'lose-response':'pass';const heldBefore=proxy.state.heldResponses;
    child=fork(workerPath,[dbPath,String(proxy.port),provider.host,bucket],{stdio:['ignore','ignore','inherit','ipc']});
    const messages=[];child.on('message',message=>messages.push(message));
    for(let i=0;!messages.some(message=>message.type==='dispatching');i++){if(i>300||child.exitCode!==null)assert.fail('worker did not dispatch');await sleep(50);}
    const key=messages.find(message=>message.type==='dispatching').key;
    if(mode!=='before'){child.send('go');for(let i=0;mode==='after'?proxy.state.heldResponses===heldBefore:!messages.some(message=>message.type==='recorded');i++){if(i>600)assert.fail('worker did not reach the '+mode+' point');await sleep(50);}}
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;child=undefined;const diedAt=Date.now();
    assert.deepEqual(await provider.list('orders/'+key),mode==='before'?[]:['orders/'+key],mode+': provider state at the kill');

    runs=new SqliteAgentRuns(dbPath);let run=runs.get(scope,'run');run=runs.recoverExpired(scope,'run',run.revision,110);
    journal=new SqliteAgentActionJournal(dbPath,{scope,runId:'run',leaseToken:'retired-token',clock:()=>110});
    assert.equal(journal.get('call').status,mode==='recorded'?'succeeded':'dispatching');assert.equal(journal.get('call').idempotencyKey,key);
    if(mode!=='recorded'){
     assert.throws(()=>runs.reconcile(scope,'run',run.revision,'retry',111),/Action requires reconciliation/);journal.markUncertain('call');
     if(mode==='before')assert.equal(await journal.reconcileWith('call',verifier(Date.now())),'unknown','too early to rule out a late write');
     await sleep(Math.max(0,settleMs-(Date.now()-diedAt)));
     assert.equal(await journal.reconcileWith('call',verifier(diedAt)),mode==='after'?'applied':'not_applied');
    }
    journal.close();journal=undefined;
    run=runs.reconcile(scope,'run',run.revision,'retry',111);run=runs.claim(scope,'run',run.revision,'recovery-worker',100,112);
    recovered=new SqliteAgentActionJournal(dbPath,{scope,runId:'run',leaseToken:run.leaseToken,clock:()=>113});let dispatches=0;
    const result=await recovered.invoke('call','orders.place',input,2,async(value,actionKey)=>{dispatches++;assert.equal(actionKey,key);const written=await putOnce(provider.port,provider.host,path(actionKey),JSON.stringify(value));return {receipt:'orders/'+actionKey,created:written.created};});
    assert.deepEqual(result,{receipt:'orders/'+key,created:true},mode);
    assert.equal(dispatches,mode==='before'?1:0,mode+': only a not-applied action is dispatched again');
    assert.equal(recovered.get('call').attempts,mode==='before'?2:1);
    assert.deepEqual(await provider.list('orders/'+key),['orders/'+key],mode+': exactly one order');
    assert.deepEqual(JSON.parse((await provider.request({method:'GET',path:path(key)})).body),input);
   }finally{if(child){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}recovered?.close();journal?.close();runs?.close();rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
  }
  // The provider's create-only write passes the idempotency contract the journal relies on.
  proxy.state.mode='pass';
  const report=await checkIdempotencyContract({
   dispatch:async(value,key)=>{const body=JSON.stringify(value),written=await putOnce(provider.port,provider.host,provider.objectPath('contract/'+key),body);if(!written.created&&written.body!==body)throw Error('Idempotency key reused for different content');return {receipt:'contract/'+key};},
   countEffects:async key=>(await provider.list('contract/'+key)).length,
   input:{sku:'C-1',quantity:1},conflictingInput:{sku:'C-1',quantity:7},
  });
  assert.equal(report.passed,true,JSON.stringify(report.findings));
 }finally{await proxy?.close();await provider?.close();}
});
