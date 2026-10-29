import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import {JSDOM} from 'jsdom';
import {EncryptedBrowserQueue,mountOfflineConflictPanel} from '../dist/offline.js';
const scope={tenantId:'t',applicationId:'a',principalId:'p'};
const setup=async()=>EncryptedBrowserQueue.open({enabled:true,databaseName:'ui',scope,key:await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']),indexedDB:new IDBFactory(),crypto:webcrypto});
const waitFor=async condition=>{for(let i=0;i<150;i++){if(await condition())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Timed out waiting for conflict panel');};
const conflict=async(queue,requestKey,payload)=>{const item=await queue.enqueue('save',requestKey,payload),running=await queue.transition(item.id,1,'claim');return queue.transition(item.id,running.version,'conflict');};

test('conflict panel compares current data and atomically queues an explicit resolution',async()=>{
 const queue=await setup(),dom=new JSDOM('<!doctype html><main></main>'),root=dom.window.document.querySelector('main'),item=await conflict(queue,'first',{name:'<script>unsafe</script>'});let calls=0;
 const panel=mountOfflineConflictPanel(root,queue,{loadCurrent:(operation,payload,identity)=>{calls++;assert.equal(operation,'save');assert.equal(identity.principalId,'p');payload.name='mutated';return {name:'server'};}});
 try{
  await panel.refresh();assert.equal(root.querySelector('script'),null);assert.match(root.textContent,/<script>unsafe<\/script>/);
  const [review,,resolve]=root.querySelectorAll('button'),edit=root.querySelector('textarea');assert.equal(resolve.disabled,true);
  review.click();await waitFor(()=>!resolve.disabled);assert.equal(calls,1);assert.match(root.textContent,/server/);assert.equal(JSON.parse(edit.value).name,'<script>unsafe</script>');
  edit.value='{bad';resolve.click();assert.match(root.textContent,/valid JSON/);assert.equal((await queue.get(item.id)).status,'conflict');
  edit.value=JSON.stringify({name:'merged'});resolve.click();await waitFor(async()=>(await queue.get(item.id)).status==='discarded');
  const original=await queue.get(item.id),replacement=await queue.get(original.replacementId);assert.equal(replacement.status,'pending');assert.deepEqual(replacement.payload,{name:'merged'});
  await waitFor(()=>root.textContent.includes('No operations need attention.'));
 }finally{panel.dispose();queue.close();dom.window.close();}
});

test('uncertain entries remain visible without an automatic retry or discard action',async()=>{
 const queue=await setup(),dom=new JSDOM('<!doctype html><main></main>'),root=dom.window.document.querySelector('main');
 const item=await queue.enqueue('charge','one',{amount:5}),running=await queue.transition(item.id,1,'claim');await queue.transition(item.id,running.version,'uncertain');
 const panel=mountOfflineConflictPanel(root,queue,{loadCurrent:()=>{throw Error('must not be called');}});
 try{await panel.refresh();assert.match(root.textContent,/remote outcome is unknown/);assert.match(root.textContent,new RegExp(item.id));assert.equal(root.querySelector('button'),null);assert.equal((await queue.get(item.id)).status,'uncertain');}
 finally{panel.dispose();queue.close();dom.window.close();}
});

test('failed current-state load cannot enable resolution and dispose cancels stale rendering',async()=>{
 const queue=await setup(),dom=new JSDOM('<!doctype html><main></main>'),root=dom.window.document.querySelector('main');let release;
 await conflict(queue,'one',{x:1});const gate=new Promise(resolve=>release=resolve),panel=mountOfflineConflictPanel(root,queue,{loadCurrent:()=>gate});
 try{
  await panel.refresh();const [review,,resolve]=root.querySelectorAll('button');review.click();assert.equal(resolve.disabled,true);panel.dispose();release({x:2});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(root.childNodes.length,0);
 }finally{panel.dispose();queue.close();dom.window.close();}
});
