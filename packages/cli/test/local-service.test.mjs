import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createProject} from '../dist/index.js';

const script=fileURLToPath(new URL('../../../deploy/local/service.mjs',import.meta.url));
const token='a-local-test-token-of-more-than-32-characters';
const launcher=fileURLToPath(new URL('./fixtures/local-service-ephemeral.mjs',import.meta.url));
async function start(role,env){
 const child=spawn(process.execPath,[launcher,role],{env,stdio:['ignore','pipe','pipe','ipc']});
 let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8192);});
 try{const port=await new Promise((resolve,reject)=>{let text='',ready=false,assigned;const cleanup=()=>{clearTimeout(timer);child.stdout.off('data',onData);child.off('message',onMessage);child.off('error',onError);child.off('close',onExit);},done=()=>{if(ready&&assigned){cleanup();resolve(assigned);}},onData=chunk=>{text=(text+chunk).slice(-8192);if(text.includes(`${role} ready`)){ready=true;done();}},onMessage=message=>{if(Number.isInteger(message?.port)&&message.port>0){assigned=message.port;done();}},onError=error=>{cleanup();reject(error);},onExit=(code,signal)=>{cleanup();reject(Error(`${role} exited: ${code??signal}${stderr?`\n${stderr}`:''}`));},timer=setTimeout(()=>{cleanup();reject(Error(`Timeout starting ${role}${stderr?`\n${stderr}`:''}`));},30000);child.stdout.on('data',onData);child.on('message',onMessage);child.once('error',onError);child.once('close',onExit);});child.stdout.resume();return {child,port};}catch(error){await stop(child);throw error;}
}
async function stop(child){if(child?.pid&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit'),timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{child.kill('SIGTERM');await done;}finally{clearTimeout(timer);}}}
test('local service roles persist publications and preserve them across initialization', {timeout:90000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-services-'));let data,control;
 try{
  const project=await createProject('demo-app',dir);
  const env={...process.env,APP_MIXER_MANIFEST:join(project,'application.json'),APP_MIXER_DATABASE:join(dir,'definitions.sqlite'),DATA_PORT:'3002',CONTROL_PORT:'3001',CONTROL_BIND:'127.0.0.1',DATA_METRICS_TOKEN:'',DATA_DRAIN_DELAY_MS:'0',CONTROL_TOKEN:token};
  const init=()=>{const result=spawnSync(process.execPath,[script,'init'],{env,encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr);};
  init();data=await start('data',env);control=await start('control',env);assert.notEqual(data.port,control.port);
  const url=`http://127.0.0.1:${control.port}`,headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  let response=await fetch(`${url}/draft/patches`,{method:'POST',headers,body:JSON.stringify({baseRevision:0,patches:[{op:'setPageTitle',pageId:'home',title:'Persisted'}]})});assert.equal(response.status,200);
  response=await fetch(`${url}/publish`,{method:'POST',headers,body:JSON.stringify({expectedRevision:1})});assert.equal(response.status,201);
  init();const published=await (await fetch(`http://127.0.0.1:${data.port}/application`)).json();assert.equal(published.version,2);assert.equal(published.definition.pages[0].title,'Persisted');
 }finally{await stop(control?.child);await stop(data?.child);await rm(dir,{recursive:true,force:true});}
});
