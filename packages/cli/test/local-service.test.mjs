import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createProject} from '../dist/index.js';

const script=fileURLToPath(new URL('../../../deploy/local/service.mjs',import.meta.url));
const token='a-local-test-token-of-more-than-32-characters';
async function freePort(){const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=s.address().port;await new Promise(resolve=>s.close(resolve));return port;}
async function start(role,env){
 const child=spawn(process.execPath,[script,role],{env,stdio:['ignore','pipe','pipe']});
 try{await new Promise((resolve,reject)=>{let text='';const cleanup=()=>{clearTimeout(timer);child.stdout.off('data',onData);child.off('error',onError);child.off('exit',onExit);},onData=chunk=>{text+=chunk;if(text.includes(`${role} ready`)){cleanup();resolve();}},onError=error=>{cleanup();reject(error);},onExit=(code,signal)=>{cleanup();reject(Error(`${role} exited: ${code??signal}`));},timer=setTimeout(()=>{cleanup();reject(Error(`Timeout starting ${role}`));},30000);child.stdout.on('data',onData);child.once('error',onError);child.once('exit',onExit);child.stderr.resume();});child.stdout.resume();return child;}catch(error){await stop(child);throw error;}
}
async function stop(child){if(child?.pid&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit'),timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{child.kill('SIGTERM');await done;}finally{clearTimeout(timer);}}}
test('local service roles persist publications and preserve them across initialization', {timeout:90000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-services-'));let data,control;
 try{
  const project=await createProject('demo-app',dir),dataPort=await freePort(),controlPort=await freePort();
  const env={...process.env,APP_MIXER_MANIFEST:join(project,'application.json'),APP_MIXER_DATABASE:join(dir,'definitions.sqlite'),DATA_PORT:String(dataPort),CONTROL_PORT:String(controlPort),CONTROL_TOKEN:token};
  const init=()=>{const result=spawnSync(process.execPath,[script,'init'],{env,encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr);};
  init();data=await start('data',env);control=await start('control',env);
  const url=`http://127.0.0.1:${controlPort}`,headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  let response=await fetch(`${url}/draft/patches`,{method:'POST',headers,body:JSON.stringify({baseRevision:0,patches:[{op:'setPageTitle',pageId:'home',title:'Persisted'}]})});assert.equal(response.status,200);
  response=await fetch(`${url}/publish`,{method:'POST',headers,body:JSON.stringify({expectedRevision:1})});assert.equal(response.status,201);
  init();const published=await (await fetch(`http://127.0.0.1:${dataPort}/application`)).json();assert.equal(published.version,2);assert.equal(published.definition.pages[0].title,'Persisted');
 }finally{await stop(control);await stop(data);await rm(dir,{recursive:true,force:true});}
});
