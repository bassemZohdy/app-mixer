import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

const service=fileURLToPath(new URL('../../../deploy/local/service.mjs',import.meta.url));
async function freePort(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function ready(url,child){for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(`Data service exited: ${child.exitCode}`);try{return await fetch(url,{signal:AbortSignal.timeout(500)});}catch{await delay(100);}}throw Error('Data service did not start');}

test('local data service exposes opt-in health and authorized metrics',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-observe-'));
 await writeFile(join(dir,'application.json'),JSON.stringify({id:'demo',schemaVersion:1,revision:0,pages:[]}));
 const dataPort=await freePort();let metricsPort=await freePort();while(metricsPort===dataPort)metricsPort=await freePort();
 const token='a'.repeat(40),env={...process.env,APP_MIXER_MANIFEST:join(dir,'application.json'),APP_MIXER_DATABASE:join(dir,'app.sqlite'),DATA_PORT:String(dataPort),DATA_METRICS_PORT:String(metricsPort),DATA_HEALTH_ENABLED:'true',DATA_METRICS_TOKEN:token};
 const init=spawnSync(process.execPath,[service,'init'],{env,encoding:'utf8'});assert.equal(init.status,0,init.stderr);
 const child=spawn(process.execPath,[service,'data'],{env,stdio:'ignore'});const data=`http://127.0.0.1:${dataPort}`,metrics=`http://127.0.0.1:${metricsPort}/metrics`;
 try{
  assert.equal((await ready(data+'/health/ready',child)).status,200);
  assert.equal((await ready(metrics,child)).status,401);
  assert.equal((await fetch(metrics,{headers:{authorization:'Bearer wrong'}})).status,401);
  const response=await fetch(metrics,{headers:{authorization:`Bearer ${token}`}});assert.equal(response.status,200);assert.match(await response.text(),/app_mixer_data_plane_requests_total/);
 }finally{if(child.exitCode===null){child.kill();await once(child,'exit');}await rm(dir,{recursive:true,force:true});}
});


test('local data service marks readiness unavailable before shutdown',{skip:process.platform==='win32',timeout:10000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-drain-'));await writeFile(join(dir,'application.json'),JSON.stringify({id:'demo',schemaVersion:1,revision:0,pages:[]}));const port=await freePort(),env={...process.env,APP_MIXER_MANIFEST:join(dir,'application.json'),APP_MIXER_DATABASE:join(dir,'app.sqlite'),DATA_PORT:String(port),DATA_HEALTH_ENABLED:'true',DATA_DRAIN_DELAY_MS:'1500'};
 const init=spawnSync(process.execPath,[service,'init'],{env,encoding:'utf8'});assert.equal(init.status,0,init.stderr);const child=spawn(process.execPath,[service,'data'],{env,stdio:'ignore'}),base=`http://127.0.0.1:${port}`;
 try{assert.equal((await ready(base+'/health/ready',child)).status,200);const exited=once(child,'exit');child.kill('SIGTERM');let response;for(let i=0;i<50;i++){response=await fetch(base+'/health/ready');if(response.status===503)break;await delay(10);}assert.equal(response.status,503);assert.equal((await fetch(base+'/health/live')).status,200);assert.equal((await fetch(base+'/application')).status,200);const [code]=await exited;assert.equal(code,0);}finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}await rm(dir,{recursive:true,force:true});}
});
