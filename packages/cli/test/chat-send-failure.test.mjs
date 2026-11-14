import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {JSDOM} from 'jsdom';
import {createProject} from '../dist/index.js';
const wait=async predicate=>{for(let n=0;n<200&&!predicate();n++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(predicate());};
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const sse=(...events)=>new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(''),{status:200,headers:{'content-type':'text/event-stream'}});

async function open(chatFetch){
 const dir=await mkdtemp(join(tmpdir(),'chat-send-'));
 const target=await createProject('demo-app',dir),html=await readFile(join(target,'index.html'),'utf8'),source=await readFile(join(target,'chat.mjs'),'utf8');
 const dom=new JSDOM(html),document=dom.window.document;
 const fetch=async (path,options)=>path==='/api/chat/status'?new Response(JSON.stringify({enabled:true}),{status:200}):chatFetch(path,options);
 await new AsyncFunction('document','fetch','crypto',source)(document,fetch,globalThis.crypto);
 const el=id=>document.getElementById(id);
 const submit=async value=>{el('chat-input').value=value;el('chat-form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await wait(()=>!el('chat-send').disabled);};
 return {el,submit,close:async()=>{dom.window.close();await rm(dir,{recursive:true,force:true});}};
}

test('FEAT-034 a message whose send failed is put back in the input and marked not sent',async()=>{
 let agentUp=false;const bodies=[];
 const app=await open(async (path,options)=>{if(!agentUp)throw new TypeError('fetch failed');bodies.push(JSON.parse(options.body));return sse({type:'TEXT_MESSAGE_CONTENT',delta:'Hello back'},{type:'RUN_FINISHED'});});
 try{
  await app.submit('Where is my order?');
  assert.equal(app.el('chat-input').value,'Where is my order?');
  assert.match(app.el('chat-log').textContent,/You: Where is my order\? \(not sent\)/);
  assert.equal(app.el('chat-log').children.length,1);
  agentUp=true;
  await app.submit(app.el('chat-input').value);
  assert.equal(bodies.length,1);
  assert.deepEqual(bodies[0].messages.map(message=>message.content),['Where is my order?'],'the failed message is not in the history sent');
  assert.match(app.el('chat-log').textContent,/Agent: Hello back/);
  assert.equal(app.el('chat-input').value,'');
 }finally{await app.close();}
});

test('FEAT-034 a refused request (not ok) also keeps the message',async()=>{
 const app=await open(async()=>new Response('{}',{status:502}));
 try{
  await app.submit('Hello');
  assert.equal(app.el('chat-input').value,'Hello');
  assert.match(app.el('chat-log').textContent,/\(not sent\)/);
 }finally{await app.close();}
});

test('FEAT-034 a reply that started and then failed does not put the message back',async()=>{
 const app=await open(async()=>sse({type:'TEXT_MESSAGE_CONTENT',delta:'Partial'}));
 try{
  await app.submit('Hello');
  assert.equal(app.el('chat-input').value,'');
  assert.match(app.el('chat-log').textContent,/Agent: Partial \(incomplete\)/);
  assert.doesNotMatch(app.el('chat-log').textContent,/not sent/);
 }finally{await app.close();}
});
