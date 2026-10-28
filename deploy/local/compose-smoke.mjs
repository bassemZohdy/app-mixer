import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {randomBytes} from 'node:crypto';

const project=`appmixerci${randomBytes(4).toString('hex')}`;
const env={...process.env,CONTROL_TOKEN:randomBytes(32).toString('hex'),AGENT_TOKEN:randomBytes(32).toString('hex')};
const compose=(...args)=>execFileSync('docker',['compose','-p',project,...args],{env,stdio:'inherit',timeout:180000});
const api='http://127.0.0.1:3000';
const control='http://127.0.0.1:3001';
async function waitFor(url,headers={}){
  for(let i=0;i<60;i++){
    try{const response=await fetch(url,{headers,signal:AbortSignal.timeout(1000)});if(response.ok)return response;}catch{}
    await delay(1000);
  }
  throw Error(`Service did not become ready: ${url}`);
}
try{
  compose('up','-d','--build');
  const auth={authorization:`Bearer ${env.CONTROL_TOKEN}`};
  const initial=await (await waitFor(`${api}/api/publication`)).json();
  assert.equal(initial.definition.pages[0].title,'Home');
  const draft=await (await waitFor(`${control}/draft`,auth)).json();
  let response=await fetch(`${control}/draft/patches`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({baseRevision:draft.revision,patches:[{op:'setPageTitle',pageId:'home',title:'Compose published'}]})});
  assert.equal(response.status,200);const updated=await response.json();
  response=await fetch(`${control}/publish`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({expectedRevision:updated.revision})});assert.equal(response.status,201);
  const body=JSON.stringify({threadId:'t',runId:'r',messages:[{id:'m',role:'user',content:'hello'}],tools:[],context:[],state:{}});
  await waitFor(`${api}/api/chat/status`);
  for(let i=0;i<30;i++){
    response=await fetch(`${api}/api/chat`,{method:'POST',headers:{origin:api,'content-type':'application/json'},body});
    if(response.ok)break;
    await delay(1000);
  }
  assert.equal(response.status,200);assert.match(await response.text(),/RUN_FINISHED/);
  compose('stop','agent');
  response=await fetch(`${api}/api/chat`,{method:'POST',headers:{origin:api,'content-type':'application/json'},body});assert.equal(response.status,502);
  assert.equal((await (await fetch(`${api}/api/publication`)).json()).definition.pages[0].title,'Compose published');
  compose('restart','data');
  assert.equal((await (await waitFor(`${api}/api/publication`)).json()).definition.pages[0].title,'Compose published');
}finally{
  try{compose('down','--volumes','--remove-orphans');}catch(error){console.error('Compose cleanup failed:',error.message);process.exitCode=1;}
}
