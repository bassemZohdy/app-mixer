import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CapabilityRegistry,SqliteStagedOperations} from '../dist/index.js';
const scope={tenantId:'tenant',applicationId:'app'},context={tenantId:'tenant',principalId:'user',origin:'ui'};
function killAtBarrier(path,id,phase){return new Promise((resolve,reject)=>{const child=fork(fileURLToPath(new URL('./fixtures/staged-reconciliation-crash.mjs',import.meta.url)),[],{env:{...process.env,STAGED_TEST_DB:path,STAGED_TEST_ID:id,STAGED_TEST_PHASE:phase},stdio:['ignore','pipe','pipe','ipc']}),errors=[];let reached=false,output='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Timed out before '+phase));},15000);child.stderr.on('data',chunk=>errors.push(String(chunk)));child.stdout.on('data',chunk=>{output+=String(chunk);if(!reached&&output.includes(phase+'\n')){reached=true;child.kill('SIGKILL');}});child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('exit',()=>{clearTimeout(timer);if(!reached)reject(Error('Worker exited before barrier: '+errors.join('')));else resolve();});});}

test('staged reconciliation evidence and state recover together after process termination',{timeout:60000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'staged-reconcile-crash-')),path=join(dir,'data.sqlite'),registry=new CapabilityRegistry(()=>{});let store=new SqliteStagedOperations(path);registry.register({operationId:'pay',method:'POST',path:'/pay'},{authorize:()=>true,validate:()=>true,execute:()=>{throw Error('lost')}});
 try{const op=store.stage(scope,'pay',{secret:'x'}),other=store.stage({...scope,tenantId:'other'},'pay',{secret:'other'});await assert.rejects(store.submit(scope,op.id,registry,context),/lost/);
  store.close();await killAtBarrier(path,op.id,'before-commit');store=new SqliteStagedOperations(path);assert.equal(store.get(scope,op.id).status,'uncertain');assert.deepEqual(store.listReconciliationEvidence(scope,op.id),[]);assert.equal(store.get({...scope,tenantId:'other'},other.id).status,'staged');
  store.close();await killAtBarrier(path,op.id,'after-commit');store=new SqliteStagedOperations(path);assert.equal(store.get(scope,op.id).status,'succeeded');const evidence=store.listReconciliationEvidence(scope,op.id);assert.equal(evidence.length,1);assert.equal(evidence[0].principalId,'operator');assert.equal(evidence[0].reference,'case');assert.equal(evidence[0].outcome,'applied');assert.equal(JSON.stringify(evidence).includes('secret'),false);assert.throws(()=>store.reconcileWithEvidence(scope,op.id,'applied',{principalId:'operator',reference:'case'}),/state/);assert.equal(store.get({...scope,tenantId:'other'},other.id).status,'staged');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
