#!/usr/bin/env node
// Capacity figures for the Kubernetes Data Plane: throughput, latency, CPU per request and memory under sustained load.
//
// Usage: node scripts/bench-data-plane.mjs [seconds=8] [connections=32]
//
// It starts deploy/kubernetes/data-plane.mjs (the process the container runs) as a child with a mounted publication,
// drives it with a keep-alive load generator in this process, and reports for each scenario the requests per second,
// latency percentiles, errors, the child's CPU time per request and its resident memory. The generator runs on the same
// machine and takes CPU from the server, so the figures are a floor for one core's worth of server, not a capacity test of
// a cluster. Use them to check the Deployment's requests and limits (50m CPU and 96Mi requested, 1 CPU and 256Mi limit).
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {Agent,request} from 'node:http';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {generateKeyPairSync} from 'node:crypto';
import {SignJWT} from 'jose';

const seconds=Number(process.argv[2]??8),connections=Number(process.argv[3]??32);
if(!Number.isFinite(seconds)||seconds<1||seconds>600||!Number.isSafeInteger(connections)||connections<1||connections>512){console.error('Usage: node scripts/bench-data-plane.mjs [seconds=8] [connections=32]');process.exit(2);}
const service=fileURLToPath(new URL('../deploy/kubernetes/data-plane.mjs',import.meta.url));
const dir=mkdtempSync(join(tmpdir(),'bench-data-plane-'));
// The child imports the real script and reports its own memory and CPU time.
const wrapper=join(dir,'wrapper.mjs');
writeFileSync(wrapper,`await import(${JSON.stringify(pathToFileURL(service).href)});setInterval(()=>process.send?.({rss:process.memoryUsage().rss,cpu:process.cpuUsage()}),200);`);

const freePort=async()=>{const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const {port}=probe.address();await new Promise(resolve=>probe.close(resolve));return port;};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const publication=(bytes)=>({version:1,definition:{id:'demo',schemaVersion:1,revision:0,pages:[{id:'home',route:'/',title:'Home',components:[{id:'text',type:'Text',props:{text:'x'.repeat(Math.max(0,bytes-300))}}]}]}});

async function start(env){
  const port=await freePort(),child=fork(wrapper,[],{env:{...process.env,...env,APP_MIXER_TRANSPORT:'http',DATA_PORT:String(port),DATA_DRAIN_DELAY_MS:'0'},stdio:['ignore','ignore','pipe','ipc']});
  const state={rss:0,cpu:{user:0,system:0},peak:0,errors:''};child.stderr.on('data',chunk=>{state.errors+=chunk;});
  child.on('message',message=>{state.rss=message.rss;state.peak=Math.max(state.peak,message.rss);state.cpu=message.cpu;});
  const base=`http://127.0.0.1:${port}`;
  for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error('Data Plane exited '+child.exitCode+': '+state.errors.slice(-500));try{if((await fetch(base+'/health/ready')).ok)break;}catch{}await pause(50);}
  return {child,base,state,port,stop:async()=>{if(child.exitCode===null){const done=once(child,'exit');child.kill();await done;}}};
}

function load(port,path,headers,duration,concurrency){
  const agent=new Agent({keepAlive:true,maxSockets:concurrency}),latencies=[],end=performance.now()+duration*1000;let errors=0,bytes=0;const statuses={};
  const one=()=>new Promise(resolve=>{
    const began=performance.now();
    const req=request({host:'127.0.0.1',port,path,agent,headers},res=>{res.on('data',chunk=>{bytes+=chunk.length;});res.on('end',()=>{latencies.push(performance.now()-began);statuses[res.statusCode]=(statuses[res.statusCode]??0)+1;resolve();});});
    req.on('error',()=>{errors++;resolve();});req.end();
  });
  const worker=async()=>{while(performance.now()<end)await one();};
  return Promise.all(Array.from({length:concurrency},worker)).then(()=>{agent.destroy();latencies.sort((a,b)=>a-b);const at=q=>latencies[Math.min(latencies.length-1,Math.floor(latencies.length*q))]??0;return {requests:latencies.length,errors,statuses,bytes,rps:latencies.length/duration,p50:at(0.5),p95:at(0.95),p99:at(0.99),max:latencies.at(-1)??0};});
}

const rows=[];
async function scenario(name,{env,path='/application',headers={}}){
  const plane=await start(env);
  try{
    await load(plane.port,path,headers,1,Math.min(8,connections)); // warm up
    const cpu0=plane.state.cpu,cpuBefore=cpu0.user+cpu0.system;await pause(300);
    const before=plane.state.cpu,startCpu=before.user+before.system;
    const result=await load(plane.port,path,headers,seconds,connections);await pause(300);
    const after=plane.state.cpu,usedCpuMs=(after.user+after.system-startCpu)/1000;
    rows.push({name,...result,cpuMsPerRequest:usedCpuMs/result.requests,serverCpuCores:usedCpuMs/1000/seconds,rssMb:plane.state.rss/1048576,peakMb:plane.state.peak/1048576});
    void cpuBefore;
  }finally{await plane.stop();}
}

try{
  for(const [label,bytes] of [['2 KB',2048],['100 KB',102400],['1 MB',1048576]]){
    const file=join(dir,`publication-${bytes}.json`);writeFileSync(file,JSON.stringify(publication(bytes)));
    await scenario(`public, ${label} publication`,{env:{APP_MIXER_PUBLICATION_PATH:file,APP_MIXER_PUBLICATION_MODE:'unsigned',APP_MIXER_ACCESS_MODE:'public'}});
  }
  // A client that already has the publication asks with its ETag and gets a 304 without the body.
  const small=join(dir,'publication-2048.json');
  const probe=await start({APP_MIXER_PUBLICATION_PATH:small,APP_MIXER_PUBLICATION_MODE:'unsigned',APP_MIXER_ACCESS_MODE:'public'});
  const etag=(await fetch(probe.base+'/application')).headers.get('etag');await probe.stop();
  if(etag)await scenario('public, 2 KB, conditional request (304)',{env:{APP_MIXER_PUBLICATION_PATH:small,APP_MIXER_PUBLICATION_MODE:'unsigned',APP_MIXER_ACCESS_MODE:'public'},headers:{'if-none-match':etag}});
  // JWT access: every request verifies an RS256 signature and the claims.
  const pair=generateKeyPairSync('rsa',{modulusLength:2048}),jwks=join(dir,'jwks.json'),now=Math.floor(Date.now()/1000);
  writeFileSync(jwks,JSON.stringify({keys:[{...pair.publicKey.export({format:'jwk'}),kid:'one',alg:'RS256',use:'sig'}]}));
  const token=await new SignJWT({iss:'https://issuer.example/',aud:'data-plane',sub:'alice',client_id:'client',jti:'id',iat:now,exp:now+3600,tenant_id:'tenant',scope:'app-mixer:publication.read'}).setProtectedHeader({alg:'RS256',kid:'one',typ:'at+jwt'}).sign(pair.privateKey);
  await scenario('JWT (RS256, no revocation store), 2 KB',{env:{APP_MIXER_PUBLICATION_PATH:small,APP_MIXER_PUBLICATION_MODE:'unsigned',APP_MIXER_ACCESS_MODE:'jwt',APP_MIXER_REVOCATION_MODE:'disabled',APP_MIXER_JWKS_PATH:jwks,APP_MIXER_JWT_ISSUER:'https://issuer.example/',APP_MIXER_JWT_AUDIENCE:'data-plane',APP_MIXER_TENANT_ID:'tenant',APP_MIXER_JWT_MAX_AGE_SECONDS:'3600'},headers:{authorization:`Bearer ${token}`}});

  const pad=(value,width)=>String(value).padStart(width);
  console.log(`\nData Plane load: ${connections} connections for ${seconds} s per scenario, Node ${process.version}, ${process.platform} ${process.arch}\n`);
  console.log('| Scenario | req/s | p50 ms | p95 ms | p99 ms | max ms | errors | server CPU ms/req | server cores | RSS MB (peak) |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for(const r of rows)console.log(`| ${r.name} | ${Math.round(r.rps)} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.p99.toFixed(1)} | ${r.max.toFixed(0)} | ${r.errors} | ${r.cpuMsPerRequest.toFixed(3)} | ${r.serverCpuCores.toFixed(2)} | ${r.rssMb.toFixed(0)} (${r.peakMb.toFixed(0)}) |`);
  console.log('\nStatus codes: '+rows.map(r=>`${r.name}: ${JSON.stringify(r.statuses)}`).join('; '));
  void pad;
}finally{rmSync(dir,{recursive:true,force:true});}
