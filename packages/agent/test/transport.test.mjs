import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { EventSchema } from '@ag-ui/core/schemas';
import { createAGUIServer, LangGraphAGUIAdapter } from '../dist/index.js';

const token='a-strong-local-token-at-least-32-characters';
const auth={authorization:`Bearer ${token}`,'content-type':'application/json'};
const input={threadId:'thread',runId:'run',messages:[{id:'m1',role:'user',content:'hello'}],tools:[],context:[],state:{}};
async function start(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function stop(server){await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
const post=(body,headers=auth)=>({method:'POST',headers,body:JSON.stringify(body)});

test('streams authenticated AG-UI events over SSE and rejects unsupported input', async () => {
  const server=createAGUIServer(new LangGraphAGUIAdapter({async *stream(){yield 'hi';yield ' there';}}),token);
  try {
    const url=await start(server);
    assert.equal((await fetch(`${url}/agent`,post(input,{'content-type':'application/json'}))).status,401);
    assert.equal((await fetch(`${url}/agent`,post({...input,tools:[{name:'unsafe',description:'',parameters:{}}]}))).status,400);
    assert.equal((await fetch(`${url}/agent`,post({...input,unexpected:true}))).status,400);
    assert.equal((await fetch(`${url}/agent`,post({...input,messages:[{id:'m',role:'system',content:'x'}]}))).status,400);
    assert.equal((await fetch(`${url}/agent`,{method:'POST',headers:auth,body:'{'})).status,400);
    assert.equal((await fetch(`${url}/agent`,{method:'POST',headers:{authorization:`Bearer ${token}`},body:'{}'})).status,415);
    const response=await fetch(`${url}/agent`,post(input));
    assert.equal(response.status,200); assert.match(response.headers.get('content-type'),/^text\/event-stream/);
    const events=(await response.text()).trim().split('\n\n').map(frame=>JSON.parse(frame.slice(6)));
    for(const event of events) EventSchema.parse(event);
    assert.equal(events[0].type,'RUN_STARTED'); assert.equal(events.at(-1).type,'RUN_FINISHED');
    assert.equal(events.filter(e=>e.type==='TEXT_MESSAGE_CONTENT').map(e=>e.delta).join(''),'hi there');
  } finally { await stop(server); }
});

test('disconnect aborts the active model stream', {timeout:10000}, async () => {
  let resolveAborted; const aborted=new Promise(resolve=>{resolveAborted=resolve;});
  const model={async *stream(_messages,signal){yield 'first';await new Promise(resolve=>{
    if(signal.aborted){resolveAborted();resolve();return;}
    signal.addEventListener('abort',()=>{resolveAborted();resolve();},{once:true});
  });}};
  const server=createAGUIServer(new LangGraphAGUIAdapter(model),token);
  try {
    const url=await start(server), controller=new AbortController();
    const response=await fetch(`${url}/agent`,{...post(input),signal:controller.signal});
    const reader=response.body.getReader();
    let received=''; const decoder=new TextDecoder();
    while(true){const result=await reader.read();if(result.done) throw Error('Stream ended early');received+=decoder.decode(result.value,{stream:true});if(received.includes('TEXT_MESSAGE_CONTENT'))break;}
    controller.abort();
    let timer;
    try { await Promise.race([aborted,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Abort was not propagated')),3000);})]); } finally {clearTimeout(timer);}
  } finally { await stop(server); }
});
