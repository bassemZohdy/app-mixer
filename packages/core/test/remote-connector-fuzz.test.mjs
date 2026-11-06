import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {ApplicationStore,createRemoteControlConnector,createPromotionPackage} from '../dist/index.js';

const definition={id:'demo',schemaVersion:1,revision:0,pages:[{id:'home',route:'/',title:'Home',components:[]}]},token='source-secret-at-least-32-characters-long',request={actor:{tenantId:'t',principalId:'admin'},sourceVersion:1,expectedVersion:0};
function rng(seed){return()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32;};}
const pick=(random,list)=>list[Math.floor(random()*list.length)];
const junk=['',' ','x',0,-1,1e308,true,null,[],{},{a:1},'__proto__',[[]],'a'.repeat(2000),'demo','other',2,'\u0000'];
function mutate(value,random){
 const copy=structuredClone(value),paths=[];(function walk(node,path){if(node&&typeof node==='object')for(const key of Object.keys(node)){paths.push([...path,key]);walk(node[key],[...path,key]);}})(copy,[]);
 for(let i=0;i<1+Math.floor(random()*3)&&paths.length;i++){const path=pick(random,paths);let node=copy;for(const key of path.slice(0,-1)){if(node==null||typeof node!=='object')break;node=node[key];}
  if(node&&typeof node==='object'){const last=path.at(-1);if(random()<0.2)delete node[last];else node[last]=structuredClone(pick(random,junk));}}
 return copy;
}
const valid=createPromotionPackage('development',{version:1,definition});

test('hostile source responses either fail closed with an Error and leave the target untouched or import only a coherent publication',{timeout:120000},async()=>{
 const random=rng(31337);let current;
 const server=createServer((req,res)=>{req.resume();current(res);});server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`;
 let rejected=0,imported=0;
 try{
  for(let i=0;i<300;i++){
   const kind=pick(random,['mutated','mutated','mutated','garbage','empty','redirect','status','huge','wrongtype']);
   current=res=>{
    if(kind==='redirect'){res.writeHead(pick(random,[301,302,307]),{location:pick(random,['http://127.0.0.1:1/x','/elsewhere','file:///etc/passwd'])});res.end();return;}
    if(kind==='status'){res.writeHead(pick(random,[204,400,401,403,404,409,429,500,502,503]),{'content-type':'application/json'});res.end(JSON.stringify(valid));return;}
    if(kind==='huge'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({...valid,padding:'x'.repeat(3*1024*1024)}));return;}
    if(kind==='wrongtype'){res.writeHead(200,{'content-type':pick(random,['text/html','text/plain','application/octet-stream'])});res.end(JSON.stringify(valid));return;}
    if(kind==='empty'){res.writeHead(200,{'content-type':'application/json'});res.end();return;}
    if(kind==='garbage'){res.writeHead(200,{'content-type':'application/json'});res.end(Buffer.from(Array.from({length:Math.floor(random()*300)},()=>Math.floor(random()*256))));return;}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(mutate(valid,random)));
   };
   const target=new ApplicationStore(definition);let outcome;
   const connector=createRemoteControlConnector({sourceOrigin:url,sourceToken:token,sourceEnvironment:'development',targetEnvironment:'production',applicationId:'demo',repository:target,allowLoopbackHttp:true,authorize:()=>true,audit:()=>{}});
   try{outcome=await connector.importPublication(request);}catch(error){outcome=error;}
   if(outcome instanceof Error){rejected++;assert.equal(target.getPublished(),undefined,`target changed after rejected ${kind} response (${outcome.message})`);}
   else{imported++;assert.equal(kind,'mutated','only a structurally valid package may import');const published=target.getPublished();assert.equal(published.version,1);assert.equal(published.definition.id,'demo');assert.ok(Array.isArray(published.definition.pages));}
  }
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 assert.ok(rejected>150,`expected most hostile responses to be rejected (rejected ${rejected}, imported ${imported})`);
});
