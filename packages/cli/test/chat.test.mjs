import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject } from '../dist/index.js';
import { createAGUIServer, LangGraphAGUIAdapter } from '../../agent/dist/index.js';

const token='a-strong-local-token-at-least-32-characters';
const input={threadId:'thread',runId:'run',messages:[{id:'m1',role:'user',content:'مرحبا'}],tools:[],context:[],state:{}};
async function stop(server){if(server.listening)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}

test('generated app proxies same-origin chat without exposing credentials and survives agent outage', {timeout:15000}, async () => {
  const agent=createAGUIServer(new LangGraphAGUIAdapter({async *stream(messages){assert.equal(messages[0].content,'مرحبا');yield 'Hello';yield ' there';}}),token);
  agent.listen(0,'127.0.0.1'); await once(agent,'listening');
  const dir=await mkdtemp(join(tmpdir(),'app-mixer-chat-'));let server;
  try {
    const target=await createProject('demo-app',dir);
    server=spawn(process.execPath,['server.mjs'],{cwd:target,env:{...process.env,PORT:'0',AGENT_URL:`http://127.0.0.1:${agent.address().port}/agent`,AGENT_TOKEN:token},stdio:['ignore','pipe','pipe']});
    const url=await new Promise((resolve,reject)=>{let output='';server.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});server.once('error',reject);server.once('exit',code=>reject(Error(`Server exited: ${code}`)));});
    const headers={'content-type':'application/json',origin:url};
    assert.equal((await (await fetch(`${url}/api/chat/status`)).json()).enabled,true);
    assert.equal((await fetch(`${url}/api/chat`,{method:'POST',headers:{...headers,origin:'https://evil.example'},body:JSON.stringify(input)})).status,403);
    const rebinding=await new Promise((resolve,reject)=>{const req=request(`${url}/api/chat`,{method:'POST',headers:{...headers,host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end(JSON.stringify(input));});
    assert.equal(rebinding,400);
    const response=await fetch(`${url}/api/chat`,{method:'POST',headers,body:JSON.stringify(input)});
    assert.equal(response.status,200);
    const events=await response.text();assert.match(events,/TEXT_MESSAGE_CONTENT/);assert.match(events,/RUN_FINISHED/);assert.doesNotMatch(events,new RegExp(token));
    assert.doesNotMatch(await (await fetch(`${url}/chat.mjs`)).text(),new RegExp(token));
    await stop(agent);
    assert.equal((await fetch(`${url}/api/chat`,{method:'POST',headers,body:JSON.stringify(input)})).status,502);
    assert.equal((await fetch(`${url}/api/application`)).status,200);
  } finally {
    await stop(agent);
    if(server && server.exitCode===null && server.signalCode===null){const done=once(server,'exit');server.kill();await done;}
    await rm(dir,{recursive:true,force:true});
  }
});
