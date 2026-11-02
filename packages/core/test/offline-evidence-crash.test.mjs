import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteOfflineQueue} from '../dist/index.js';
const scope={tenantId:'tenant',applicationId:'app'},other={tenantId:'other',applicationId:'app'},policy={enabled:true,maxAttempts:2,retryDelayMs:0},evidence={operatorId:'operator',reference:'case'};
async function killAtBarrier(path,barrier,action,phase,id){const child=fork(fileURLToPath(new URL('./fixtures/offline-evidence-crash.mjs',import.meta.url)),[path,barrier,action,phase,id],{stdio:['ignore','ignore','pipe','ipc']});let errors='',problem,exited=false;child.stderr.on('data',data=>errors+=String(data));child.on('message',message=>{if(message?.error)problem=message.error;});const exit=new Promise(resolve=>child.once('exit',()=>{exited=true;resolve();}));try{const limit=Date.now()+15000;while(!existsSync(barrier)){if(exited||problem)throw Error(`Worker exited before barrier: ${problem??errors}`);if(Date.now()>limit)throw Error('Worker did not reach barrier');await new Promise(resolve=>setTimeout(resolve,20));}child.kill('SIGKILL');await exit;}finally{if(!exited){child.kill('SIGKILL');await exit;}}}
for(const action of ['recover','reconcile'])for(const phase of ['during','after'])test(`offline ${action} evidence survives process termination ${phase} transaction`,{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'offline-evidence-crash-')),path=join(dir,'db.sqlite'),barrier=join(dir,'barrier');let queue=new SqliteOfflineQueue(path,policy),db=new DatabaseSync(path);
 try{const item=queue.enqueue(scope,'owner','change','request',{private:'secret'}),foreign=queue.enqueue(other,'owner','change','request',{private:'other'});db.prepare("UPDATE offline_operations SET status='running',attempts=1 WHERE id IN (?,?)").run(item.id,foreign.id);if(action==='reconcile')queue.recoverAbandonedWithEvidence(scope,'owner',item.id,{operatorId:'operator',reference:'prior'},1);db.close();db=undefined;queue.close();queue=undefined;
  await killAtBarrier(path,barrier,action,phase,item.id);db=new DatabaseSync(path);db.exec('DROP TRIGGER IF EXISTS test_offline_evidence_crash');db.close();db=undefined;queue=new SqliteOfflineQueue(path,policy);const committed=phase==='after',expected=action==='recover'?(committed?'uncertain':'running'):(committed?'succeeded':'uncertain');assert.equal(queue.get(scope,'owner',item.id).status,expected);assert.equal(queue.listRecoveryEvidence(scope,'owner',item.id).length,(action==='reconcile'?1:0)+(committed?1:0));assert.equal(queue.get(other,'owner',foreign.id).status,'running');assert.deepEqual(queue.listRecoveryEvidence(other,'owner',foreign.id),[]);
  if(!committed){if(action==='recover')queue.recoverAbandonedWithEvidence(scope,'owner',item.id,evidence,10);else queue.reconcileWithEvidence(scope,'owner',item.id,'applied',evidence,10);}const events=queue.listRecoveryEvidence(scope,'owner',item.id);assert.equal(events.at(-1).reference,'case');assert.equal(events.at(-1).action,action==='recover'?'recover':'applied');assert.equal(JSON.stringify(events).includes('secret'),false);assert.equal(queue.get(scope,'owner',item.id).status,action==='recover'?'uncertain':'succeeded');
 }finally{db?.close();queue?.close();rmSync(dir,{recursive:true,force:true});}
});
