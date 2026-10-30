import {readFile,stat} from 'node:fs/promises';
import {createDataPlane,validate} from '../../packages/core/dist/index.js';

// The release pipeline must authenticate and approve this mounted publication.
const path=process.env.APP_MIXER_PUBLICATION_PATH;
if(!path)throw Error('APP_MIXER_PUBLICATION_PATH is required');
if((await stat(path)).size>1024*1024)throw Error('Publication too large');
const publication=JSON.parse(await readFile(path,'utf8'));
if(!publication||typeof publication!=='object'||Array.isArray(publication)||Object.keys(publication).sort().join(',')!=='definition,version'||!Number.isSafeInteger(publication.version)||publication.version<1)throw Error('Invalid publication');
validate(publication.definition);
const snapshot=structuredClone(publication),repository={getPublished(version){return version===undefined||version===snapshot.version?structuredClone(snapshot):undefined;}};
const portText=process.env.DATA_PORT??'3002',delayText=process.env.DATA_DRAIN_DELAY_MS??'5000';
if(!/^[1-9][0-9]{0,4}$/.test(portText)||Number(portText)>65535||!/^(0|[1-9][0-9]{0,4})$/.test(delayText)||Number(delayText)>30000)throw Error('Invalid Data Plane configuration');
const server=createDataPlane(repository,{health:{timeoutMs:1000}});server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
server.listen(Number(portText),'0.0.0.0');
server.once('listening',()=>console.log('Data Plane ready'));
let stopping=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(stopping)return;stopping=true;server.beginDrain();setTimeout(()=>server.close(),Number(delayText));});
