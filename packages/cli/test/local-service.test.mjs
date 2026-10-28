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
async function start(role,env){const child=spawn(process.execPath,[script,role],{env,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error(`Timeout starting ${role}`)),5000);child.stdout.on('data',chunk=>{text+=chunk;if(text.includes(`${role} ready`)){clearTimeout(timer);resolve();}});child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);reject(Error(`${role} exited: ${code}`));});});return child;}
async function stop(child){if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}}
test('local service roles persist publications and preserve them across initialization', {timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-services-'));let data,control;
 try{
  const project=await createProject('demo-app',dir),dataPort=await freePort(),controlPort=await freePort();
  const env={...process.env,APP_MIXER_MANIFEST:join(project,'application.json'),APP_MIXER_DATABASE:join(dir,'definitions.sqlite'),DATA_PORT:String(dataPort),CONTROL_PORT:String(controlPort),CONTROL_TOKEN:token};
  const init=()=>{const result=spawnSync(process.execPath,[script,'init'],{env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);};
  init();data=await start('data',env);control=await start('control',env);
  const url=`http://127.0.0.1:${controlPort}`,headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  let response=await fetch(`${url}/draft/patches`,{method:'POST',headers,body:JSON.stringify({baseRevision:0,patches:[{op:'setPageTitle',pageId:'home',title:'Persisted'}]})});assert.equal(response.status,200);
  response=await fetch(`${url}/publish`,{method:'POST',headers,body:JSON.stringify({expectedRevision:1})});assert.equal(response.status,201);
  init();const published=await (await fetch(`http://127.0.0.1:${dataPort}/application`)).json();assert.equal(published.version,2);assert.equal(published.definition.pages[0].title,'Persisted');
 }finally{await stop(control);await stop(data);await rm(dir,{recursive:true,force:true});}
});
