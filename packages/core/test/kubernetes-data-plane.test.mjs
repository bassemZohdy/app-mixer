import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const service=fileURLToPath(new URL('../../../deploy/kubernetes/data-plane.mjs',import.meta.url));
async function port(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value;}
async function awaitReady(url,child){for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(`Data Plane exited: ${child.exitCode}`);try{return await fetch(url,{signal:AbortSignal.timeout(500)});}catch{await delay(50);}}throw Error('Data Plane failed to start');}
test('mounted publication stays immutable and serves readiness without a Control Plane',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-k8s-data-')),path=join(dir,'publication.json'),p=await port(),publication={version:7,definition:{id:'demo',schemaVersion:1,revision:2,pages:[]}};await writeFile(path,JSON.stringify(publication));const child=spawn(process.execPath,[service],{env:{...process.env,APP_MIXER_PUBLICATION_PATH:path,DATA_PORT:String(p),DATA_DRAIN_DELAY_MS:'0'},stdio:'ignore'}),base=`http://127.0.0.1:${p}`;
 try{assert.equal((await awaitReady(base+'/health/ready',child)).status,200);assert.deepEqual(await (await fetch(base+'/application')).json(),publication);assert.equal((await fetch(base+'/application/versions/7')).status,200);assert.equal((await fetch(base+'/application/versions/6')).status,404);await writeFile(path,JSON.stringify({...publication,version:8}));assert.deepEqual(await (await fetch(base+'/application')).json(),publication);}finally{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}await rm(dir,{recursive:true,force:true});}
});
test('missing or malformed publication fails startup',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-k8s-invalid-')),path=join(dir,'publication.json');try{for(const value of [{version:0,definition:{}},{version:1,definition:{}},{version:1,definition:{id:'demo',schemaVersion:1,revision:0,pages:[]},extra:true}]){await writeFile(path,JSON.stringify(value));const child=spawnSync(process.execPath,[service],{env:{...process.env,APP_MIXER_PUBLICATION_PATH:path,DATA_PORT:'3002'},encoding:'utf8',timeout:10000});assert.notEqual(child.status,0);}}finally{await rm(dir,{recursive:true,force:true});}
});
