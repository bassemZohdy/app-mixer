import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {request as httpsRequest} from 'node:https';
import {readFileSync} from 'node:fs';
import {generateKeyPairSync} from 'node:crypto';
import {SignJWT} from 'jose';
import {signPublicationRelease,verifyPublicationRelease} from '../dist/index.js';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const service=fileURLToPath(new URL('../../../deploy/kubernetes/data-plane.mjs',import.meta.url));
async function port(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value;}
async function awaitReady(url,child){for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(`Data Plane exited: ${child.exitCode}`);try{return await fetch(url,{signal:AbortSignal.timeout(500)});}catch{await delay(50);}}throw Error('Data Plane failed to start');}
test('mounted publication stays immutable and serves readiness without a Control Plane',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-k8s-data-')),path=join(dir,'publication.json'),p=await port(),publication={version:7,definition:{id:'demo',schemaVersion:1,revision:2,pages:[]}};await writeFile(path,JSON.stringify(publication));const child=spawn(process.execPath,[service],{env:{...process.env,APP_MIXER_TRANSPORT:'http',APP_MIXER_ACCESS_MODE:'public',APP_MIXER_PUBLICATION_PATH:path,APP_MIXER_PUBLICATION_MODE:'unsigned',DATA_PORT:String(p),DATA_DRAIN_DELAY_MS:'0'},stdio:'ignore'}),base=`http://127.0.0.1:${p}`;
 try{assert.equal((await awaitReady(base+'/health/ready',child)).status,200);assert.deepEqual(await (await fetch(base+'/application')).json(),publication);assert.equal((await fetch(base+'/application/versions/7')).status,200);assert.equal((await fetch(base+'/application/versions/6')).status,404);await writeFile(path,JSON.stringify({...publication,version:8}));assert.deepEqual(await (await fetch(base+'/application')).json(),publication);}finally{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}await rm(dir,{recursive:true,force:true});}
});
test('missing or malformed publication fails startup',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-k8s-invalid-')),path=join(dir,'publication.json');try{for(const value of [{version:0,definition:{}},{version:1,definition:{}},{version:1,definition:{id:'demo',schemaVersion:1,revision:0,pages:[]},extra:true}]){await writeFile(path,JSON.stringify(value));const child=spawnSync(process.execPath,[service],{env:{...process.env,APP_MIXER_TRANSPORT:'http',APP_MIXER_ACCESS_MODE:'public',APP_MIXER_PUBLICATION_PATH:path,APP_MIXER_PUBLICATION_MODE:'unsigned',DATA_PORT:'3002'},encoding:'utf8',timeout:10000});assert.notEqual(child.status,0);}}finally{await rm(dir,{recursive:true,force:true});}
});


test('signed mode starts only for a trusted release bound to the app and environment',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-signed-release-')),path=join(dir,'release.json'),keyPath=join(dir,'keys.json'),pair=generateKeyPairSync('ed25519'),release=signPublicationRelease({version:3,definition:{id:'demo',schemaVersion:1,revision:0,pages:[]}},'production','key-1',pair.privateKey),p=await port();await writeFile(path,JSON.stringify(release));await writeFile(keyPath,JSON.stringify([{keyId:'key-1',publicKey:pair.publicKey.export({format:'pem',type:'spki'})}]));const env={...process.env,APP_MIXER_TRANSPORT:'http',APP_MIXER_ACCESS_MODE:'public',APP_MIXER_PUBLICATION_PATH:path,APP_MIXER_PUBLICATION_MODE:'signed',APP_MIXER_RELEASE_KEYS_PATH:keyPath,APP_MIXER_RELEASE_ENV:'production',APP_MIXER_APPLICATION_ID:'demo',DATA_PORT:String(p),DATA_DRAIN_DELAY_MS:'0'};const child=spawn(process.execPath,[service],{env,stdio:'ignore'});
 try{assert.equal((await awaitReady(`http://127.0.0.1:${p}/health/ready`,child)).status,200);assert.equal((await (await fetch(`http://127.0.0.1:${p}/application`)).json()).version,3);}finally{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}}
 try{for(const changed of [{...release,publication:{...release.publication,version:4}},{...release,environment:'staging'},{...release,keyId:'unknown'}]){await writeFile(path,JSON.stringify(changed));const result=spawnSync(process.execPath,[service],{env,encoding:'utf8',timeout:10000});assert.notEqual(result.status,0);}await writeFile(path,JSON.stringify(release));const missing=spawnSync(process.execPath,[service],{env:{...env,APP_MIXER_RELEASE_KEYS_PATH:''},encoding:'utf8',timeout:10000});assert.notEqual(missing.status,0);await writeFile(keyPath,JSON.stringify([{keyId:'key-1',publicKey:pair.privateKey.export({format:'pem',type:'pkcs8'})}]));const privateKey=spawnSync(process.execPath,[service],{env,encoding:'utf8',timeout:10000});assert.notEqual(privateKey.status,0);}finally{await rm(dir,{recursive:true,force:true});}
});


test('release signing command creates a verifiable artifact without overwriting files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-signer-')),raw=join(dir,'publication.json'),key=join(dir,'private.pem'),out=join(dir,'signed.json'),pair=generateKeyPairSync('ed25519'),script=fileURLToPath(new URL('../../../deploy/kubernetes/sign-publication.mjs',import.meta.url)),publication={version:1,definition:{id:'demo',schemaVersion:1,revision:0,pages:[]}};
 try{await writeFile(raw,JSON.stringify(publication));await writeFile(key,pair.privateKey.export({type:'pkcs8',format:'pem'}));const result=spawnSync(process.execPath,[script,raw,out,key,'key-1','production'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);const {readFile}=await import('node:fs/promises');assert.deepEqual(verifyPublicationRelease(JSON.parse(await readFile(out,'utf8')),'production','demo',[{keyId:'key-1',publicKey:pair.publicKey}]),publication);assert.notEqual(spawnSync(process.execPath,[script,raw,out,key,'key-1','production'],{encoding:'utf8'}).status,0);}finally{await rm(dir,{recursive:true,force:true});}
});


test('JWT access mode requires a verified scoped tenant token for publication reads',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-jwt-data-')),path=join(dir,'publication.json'),keys=join(dir,'jwks.json'),p=await port(),pair=generateKeyPairSync('rsa',{modulusLength:2048}),now=Math.floor(Date.now()/1000),pub={version:1,definition:{id:'demo',schemaVersion:1,revision:0,pages:[]}};await writeFile(path,JSON.stringify(pub));await writeFile(keys,JSON.stringify({keys:[{...pair.publicKey.export({format:'jwk'}),kid:'one',alg:'RS256',use:'sig'}]}));const env={...process.env,APP_MIXER_PUBLICATION_PATH:path,APP_MIXER_PUBLICATION_MODE:'unsigned',APP_MIXER_TRANSPORT:'http',APP_MIXER_ACCESS_MODE:'jwt',APP_MIXER_JWKS_PATH:keys,APP_MIXER_JWT_ISSUER:'https://issuer.example/',APP_MIXER_JWT_AUDIENCE:'data-plane',APP_MIXER_TENANT_ID:'tenant',DATA_PORT:String(p),DATA_DRAIN_DELAY_MS:'0'},child=spawn(process.execPath,[service],{env,stdio:'ignore'}),base=`http://127.0.0.1:${p}`;
 const token=claims=>new SignJWT({iss:env.APP_MIXER_JWT_ISSUER,aud:env.APP_MIXER_JWT_AUDIENCE,sub:'alice',client_id:'client',jti:'id',iat:now,exp:now+300,tenant_id:'tenant',scope:'app-mixer:publication.read',...claims}).setProtectedHeader({alg:'RS256',kid:'one',typ:'at+jwt'}).sign(pair.privateKey);
 try{assert.equal((await awaitReady(base+'/health/ready',child)).status,200);assert.equal((await fetch(base+'/application')).status,403);const valid=await token({}),get=t=>fetch(base+'/application',{headers:{authorization:`Bearer ${t}`}});assert.equal((await get(valid)).status,200);assert.equal((await get(await token({tenant_id:'other'}))).status,403);assert.equal((await get(await token({scope:'other'}))).status,403);assert.equal((await get(await token({exp:now-1}))).status,403);assert.equal((await get(await token({aud:'other'}))).status,403);}finally{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}await rm(dir,{recursive:true,force:true});}
});


test('TLS transport requires a trusted certificate and rejects missing TLS configuration',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'app-mixer-tls-data-')),path=join(dir,'publication.json'),p=await port(),fixture=name=>fileURLToPath(new URL(`./fixtures/capability-tls/${name}.pem`,import.meta.url));await writeFile(path,JSON.stringify({version:1,definition:{id:'demo',schemaVersion:1,revision:0,pages:[]}}));const env={...process.env,APP_MIXER_PUBLICATION_PATH:path,APP_MIXER_PUBLICATION_MODE:'unsigned',APP_MIXER_ACCESS_MODE:'public',APP_MIXER_TRANSPORT:'tls',APP_MIXER_TLS_CERT_PATH:fixture('server-cert'),APP_MIXER_TLS_KEY_PATH:fixture('server-key'),DATA_PORT:String(p),DATA_DRAIN_DELAY_MS:'0'},child=spawn(process.execPath,[service],{env,stdio:'ignore'}),get=ca=>new Promise((resolve,reject)=>{const req=httpsRequest({host:'127.0.0.1',port:p,path:'/application',ca},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});
 try{let ready=false;for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('Data Plane exited');try{assert.equal(await get(readFileSync(fixture('ca-cert'))),200);ready=true;break;}catch(error){if(error.code!=='ECONNREFUSED')throw error;await delay(50);}}assert.equal(ready,true);await assert.rejects(get(readFileSync(fixture('rogue-cert'))));}finally{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}}
 try{assert.notEqual(spawnSync(process.execPath,[service],{env:{...env,APP_MIXER_TLS_KEY_PATH:''},encoding:'utf8',timeout:10000}).status,0);assert.notEqual(spawnSync(process.execPath,[service],{env:{...env,APP_MIXER_TLS_CLIENT_CA_PATH:''},encoding:'utf8',timeout:10000}).status,0);}finally{await rm(dir,{recursive:true,force:true});}
});
