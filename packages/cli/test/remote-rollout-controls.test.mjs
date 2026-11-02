import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';
import {createProject} from '../dist/index.js';

const waitFor=async condition=>{for(let i=0;i<100;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Timed out');};
test('rollout controls require a gate check and handle pending and uncertain actions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rollout-controls-')),originalFetch=globalThis.fetch;let dom;
 try{
  const target=await createProject('demo-app',dir),{mountRemoteRolloutControls}=await import(pathToFileURL(join(target,'offline-runtime.mjs')).href),calls=[];let gate='idle',pending=true,fail=false;
  globalThis.fetch=async(url,request)=>{const input=JSON.parse(request.body);calls.push({url,input});if(url.endsWith('/status'))return new Response(JSON.stringify({result:{phase:gate,sourceVersion:null,expectedVersion:null}}));if(fail){fail=false;throw Error('connection lost');}return new Response(JSON.stringify({result:{running:input.action==='start',inFlight:pending,stopPending:input.action==='stop'&&pending,reviewRequired:false}}));};
  dom=new JSDOM('<main></main>');const root=dom.window.document.querySelector('main'),view=mountRemoteRolloutControls(root,{statusOperation:'status',controlOperation:'control'}),button=text=>[...root.querySelectorAll('button')].find(el=>el.textContent===text);
  assert.equal(button('Start poller').disabled,true);await view.refresh();assert.equal(button('Start poller').disabled,false);button('Stop poller').click();await waitFor(()=>root.textContent.includes('stop pending'));await view.refresh();assert.equal(button('Start poller').disabled,true);pending=false;button('Stop poller').click();await waitFor(()=>root.textContent.includes('Poller: stopped.'));await view.refresh();assert.equal(button('Start poller').disabled,false);
  fail=true;button('Start poller').click();await waitFor(()=>root.textContent.includes('Control outcome unknown'));await view.refresh();assert.equal(button('Start poller').disabled,true);button('Stop poller').click();await waitFor(()=>root.textContent.includes('Poller: stopped.'));gate='running';await view.refresh();assert.equal(button('Start poller').disabled,true);assert.deepEqual(calls.filter(x=>x.url.endsWith('/control')).map(x=>x.input.action),['stop','stop','start','stop']);view.dispose();assert.equal(root.children.length,0);
 }finally{globalThis.fetch=originalFetch;dom?.window.close();await rm(dir,{recursive:true,force:true});}
});

test('disposed rollout controls ignore late status responses',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rollout-controls-dispose-')),originalFetch=globalThis.fetch;let dom,release;
 try{const target=await createProject('demo-app',dir),{mountRemoteRolloutControls}=await import(pathToFileURL(join(target,'offline-runtime.mjs')).href),waiting=new Promise(resolve=>release=resolve);globalThis.fetch=async()=>{await waiting;return new Response(JSON.stringify({result:{phase:'idle',sourceVersion:null,expectedVersion:null}}));};dom=new JSDOM('<main></main>');const root=dom.window.document.querySelector('main'),view=mountRemoteRolloutControls(root,{statusOperation:'status',controlOperation:'control'}),request=view.refresh();view.dispose();release();await request;assert.equal(root.children.length,0);
 }finally{release?.();globalThis.fetch=originalFetch;dom?.window.close();await rm(dir,{recursive:true,force:true});}
});

test('rollout recovery requires a reference, shows evidence safely, and fences uncertain outcomes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rollout-recovery-')),originalFetch=globalThis.fetch;let dom;
 try{
  const target=await createProject('demo-app',dir),{mountRemoteRolloutRecovery}=await import(pathToFileURL(join(target,'offline-runtime.mjs')).href),calls=[],cursor='A'.repeat(48);let fail=true;
  globalThis.fetch=async(url,request)=>{const input=JSON.parse(request.body);calls.push({url,input});if(url.endsWith('/status'))return new Response(JSON.stringify({result:{phase:'uncertain',sourceVersion:7,expectedVersion:6}}));if(url.endsWith('/recover')){if(fail){fail=false;throw Error('lost response');}return new Response(JSON.stringify({result:{recovered:true}}));}return new Response(JSON.stringify({result:{items:[{phase:'uncertain',principalId:'operator',reference:'<img src=x>',observedAt:10,sourceVersion:7,expectedVersion:6}],...(!input.cursor?{nextCursor:cursor}:{})}}));};
  dom=new JSDOM('<main></main>');const root=dom.window.document.querySelector('main'),view=mountRemoteRolloutRecovery(root,{statusOperation:'status',recoveryOperation:'recover',evidenceOperation:'evidence'}),button=text=>[...root.querySelectorAll('button')].find(el=>el.textContent===text),input=root.querySelector('input');
  assert.equal(button('Request verified recovery').disabled,true);await view.refresh();assert.match(root.textContent,/source version 7/);input.value='case-42';input.dispatchEvent(new dom.window.Event('input'));button('Request verified recovery').click();await waitFor(()=>root.textContent.includes('Recovery outcome unknown'));assert.equal(button('Request verified recovery').disabled,true);button('View recovery evidence').click();await waitFor(()=>root.textContent.includes('<img src=x>'));assert.equal(root.querySelector('img'),null);button('Next evidence page').click();await waitFor(()=>calls.some(call=>call.input.cursor===cursor)&&button('Next evidence page').disabled&&!button('View recovery evidence').disabled);await view.refresh();input.value='case-42';input.dispatchEvent(new dom.window.Event('input'));button('Request verified recovery').click();await waitFor(()=>root.textContent.includes('Recovery accepted'));assert.equal(button('Request verified recovery').disabled,true);assert.deepEqual(calls.filter(call=>call.url.endsWith('/recover')).map(call=>call.input),[{reference:'case-42'},{reference:'case-42'}]);view.dispose();
 }finally{globalThis.fetch=originalFetch;dom?.window.close();await rm(dir,{recursive:true,force:true});}
});
