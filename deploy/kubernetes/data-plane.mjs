import {readFile,stat} from 'node:fs/promises';
import {createPublicKey} from 'node:crypto';
import {createDataPlane,validate,verifyPublicationRelease} from '../../packages/core/dist/index.js';

// The host owns release approval and the trust roots mounted separately from the publication.
const path=process.env.APP_MIXER_PUBLICATION_PATH;
if(!path)throw Error('APP_MIXER_PUBLICATION_PATH is required');
if((await stat(path)).size>1024*1024+4096)throw Error('Publication too large');
const input=JSON.parse(await readFile(path,'utf8')),mode=process.env.APP_MIXER_PUBLICATION_MODE??'signed';let publication;
if(mode==='signed'){
 const keyPath=process.env.APP_MIXER_RELEASE_KEYS_PATH,environment=process.env.APP_MIXER_RELEASE_ENV,applicationId=process.env.APP_MIXER_APPLICATION_ID;
 if(!keyPath||!environment||!applicationId||(await stat(keyPath)).size>32768)throw Error('Invalid release verification configuration');
 const raw=JSON.parse(await readFile(keyPath,'utf8'));if(!Array.isArray(raw)||raw.length<1||raw.length>20)throw Error('Invalid release verification configuration');
 const keys=raw.map(entry=>{if(!entry||typeof entry!=='object'||Array.isArray(entry)||Object.keys(entry).sort().join(',')!=='keyId,publicKey'||typeof entry.publicKey!=='string'||entry.publicKey.length>4096||!/^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----\s*$/.test(entry.publicKey))throw Error('Invalid release verification configuration');return {keyId:entry.keyId,publicKey:createPublicKey(entry.publicKey)};});
 publication=verifyPublicationRelease(input,environment,applicationId,keys);
}else if(mode==='unsigned'){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='definition,version'||!Number.isSafeInteger(input.version)||input.version<1)throw Error('Invalid publication');validate(input.definition);publication=input;
}else throw Error('Invalid publication mode');
const snapshot=structuredClone(publication),repository={getPublished(version){return version===undefined||version===snapshot.version?structuredClone(snapshot):undefined;}};
const portText=process.env.DATA_PORT??'3002',delayText=process.env.DATA_DRAIN_DELAY_MS??'5000';
if(!/^[1-9][0-9]{0,4}$/.test(portText)||Number(portText)>65535||!/^(0|[1-9][0-9]{0,4})$/.test(delayText)||Number(delayText)>30000)throw Error('Invalid Data Plane configuration');
const server=createDataPlane(repository,{health:{timeoutMs:1000}});server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
server.listen(Number(portText),'0.0.0.0');
server.once('listening',()=>console.log('Data Plane ready'));
let stopping=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(stopping)return;stopping=true;server.beginDrain();setTimeout(()=>server.close(),Number(delayText));});
