import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createProject} from '../dist/index.js';
const SETTINGS=['PORT','DATA_PLANE_URL','AGENT_URL','AGENT_TOKEN','CAPABILITY_URL','CAPABILITY_TOKEN','CONNECT_ORIGINS'];
const token='t'.repeat(32);

function run(target,env,{killOnListen=false}={}){
 const clean={...process.env};for(const name of SETTINGS)delete clean[name];
 const child=spawn(process.execPath,['server.mjs'],{cwd:target,env:{...clean,PORT:'0',...env},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';
 child.stdout.on('data',chunk=>{stdout+=chunk;if(killOnListen&&/http:\/\/127\.0\.0\.1:\d+/.test(stdout))child.kill();});
 child.stderr.on('data',chunk=>stderr+=chunk);
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill();reject(new Error('server did not exit'));},10000);
  child.once('error',reject);
  child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});
 });
}
function oneLine(result,setting){
 assert.notEqual(result.code,0,`${setting} should exit non-zero (stderr: ${result.stderr})`);
 const lines=result.stderr.split(/\r?\n/).filter(line=>line.trim());
 assert.equal(lines.length,1,`${setting} should print one line, got: ${result.stderr}`);
 assert.doesNotMatch(result.stderr,/\n\s+at |node:internal|\.mjs:\d+/);
 assert.match(lines[0],new RegExp(setting));
}

test('FIX-030 a bad setting makes the generated server exit with one line naming it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'server-startup-'));
 try{
  const target=await createProject('startup-app',dir);
  const cases=[
   ['PORT',{PORT:'abc'}],['PORT',{PORT:'70000'}],['PORT',{PORT:'-1'}],['PORT',{PORT:'1.5'}],
   ['DATA_PLANE_URL',{DATA_PLANE_URL:'not a url'}],['DATA_PLANE_URL',{DATA_PLANE_URL:'https://127.0.0.1:9/application'}],['DATA_PLANE_URL',{DATA_PLANE_URL:'http://example.com:9/application'}],['DATA_PLANE_URL',{DATA_PLANE_URL:'http://127.0.0.1:9/other'}],
   ['AGENT_URL',{AGENT_URL:'not a url',AGENT_TOKEN:token}],['AGENT_URL',{AGENT_URL:'http://127.0.0.1:9/other',AGENT_TOKEN:token}],['AGENT_TOKEN',{AGENT_URL:'http://127.0.0.1:9/agent',AGENT_TOKEN:'short'}],['AGENT_TOKEN',{AGENT_URL:'http://127.0.0.1:9/agent'}],
   ['CAPABILITY_URL',{CAPABILITY_URL:'not a url',CAPABILITY_TOKEN:token}],['CAPABILITY_URL',{CAPABILITY_URL:'http://127.0.0.1:9/other/',CAPABILITY_TOKEN:token}],['CAPABILITY_TOKEN',{CAPABILITY_URL:'http://127.0.0.1:9/capabilities/',CAPABILITY_TOKEN:'short'}],['CAPABILITY_TOKEN',{CAPABILITY_URL:'http://127.0.0.1:9/capabilities/'}],
   ['CONNECT_ORIGINS',{CONNECT_ORIGINS:'not a url'}],['CONNECT_ORIGINS',{CONNECT_ORIGINS:'https://api.example.com/path'}],['CONNECT_ORIGINS',{CONNECT_ORIGINS:'https://api.example.com/'}],['CONNECT_ORIGINS',{CONNECT_ORIGINS:'ftp://api.example.com'}],['CONNECT_ORIGINS',{CONNECT_ORIGINS:'https://user:pass@api.example.com'}],['CONNECT_ORIGINS',{CONNECT_ORIGINS:'https://ok.example.com bad'}]
  ];
  for(const [setting,env] of cases)oneLine(await run(target,env),setting);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('FIX-030 a port already in use exits with one line naming PORT',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'server-startup-port-'));
 const blocker=createServer();
 try{
  const target=await createProject('startup-app',dir);
  await new Promise(resolve=>blocker.listen(0,'127.0.0.1',resolve));
  const result=await run(target,{PORT:String(blocker.address().port)});
  oneLine(result,'PORT');
  assert.match(result.stderr,/in use/);
 }finally{await new Promise(resolve=>blocker.close(resolve));await rm(dir,{recursive:true,force:true});}
});

test('FIX-030 unset and empty settings still start the server',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'server-startup-ok-'));
 try{
  const target=await createProject('startup-app',dir);
  for(const env of [{},{DATA_PLANE_URL:'',AGENT_URL:'',AGENT_TOKEN:'',CAPABILITY_URL:'',CAPABILITY_TOKEN:''},{AGENT_URL:'http://127.0.0.1:9/agent',AGENT_TOKEN:token,CAPABILITY_URL:'http://127.0.0.1:9/capabilities/',CAPABILITY_TOKEN:token,DATA_PLANE_URL:'http://127.0.0.1:9/application'}]){
   const result=await run(target,env,{killOnListen:true});
   assert.match(result.stdout,/http:\/\/127\.0\.0\.1:\d+/,`should start with ${JSON.stringify(Object.keys(env))}: ${result.stderr}`);
   assert.equal(result.stderr,'');
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
