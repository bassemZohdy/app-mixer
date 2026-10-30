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
