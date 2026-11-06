import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {request} from 'node:http';
import {ApplicationStore,createControlPlane,createDataPlane} from '../dist/index.js';

const token='control-secret-at-least-32-characters-long',definition={id:'demo',schemaVersion:1,revision:0,pages:[{id:'home',route:'/',title:'Home',components:[]}]};
function rng(seed){return()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32;};}
const pick=(random,list)=>list[Math.floor(random()*list.length)];
const text=(random,max)=>Array.from({length:Math.floor(random()*max)},()=>String.fromCharCode(32+Math.floor(random()*95))).join('');
const methods=['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS','TRACE','CONNECT','PROPFIND','get'],paths=['/','/application','/application/','/application/versions/1','/application/versions/0','/application/versions/-1','/application/versions/99999999999999999999','/application/versions/1/../1','/draft','/preview','/draft/patches','/draft/migrate','/publish','/health/live','/health/ready','/metrics','//','/%00','/%2e%2e/%2e%2e/etc/passwd','/application?x=1','/application#frag','/'+'a'.repeat(9000)];
const bodies=()=>['','{}','[]','null','{"baseRevision":0,"patches":[]}','{"baseRevision":"0","patches":{}}','{"baseRevision":-1,"patches":[{"op":"__proto__"}]}','{"expectedRevision":1e999}','{"__proto__":{"polluted":true}}','\u0000\u0001','{"patches":['+'{"op":"addPage"},'.repeat(2000)+'{}]}'];
function send(port,options,body){return new Promise(resolve=>{const req=request({host:'127.0.0.1',port,...options},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode}));});req.on('error',error=>resolve({error:error.code??error.message}));for(const event of ['connect','upgrade'])req.on(event,(res,socket)=>{socket.destroy();resolve({status:res.statusCode});});req.setTimeout(4000,()=>{req.destroy();resolve({error:'timeout'});});if(body)req.write(body);req.end();});}

test('hostile requests never produce a 5xx, crash the process or break later valid requests',{timeout:120000},async()=>{
 const random=rng(8675309),store=new ApplicationStore(definition);store.apply(0,[]);store.publish(1);
 const control=createControlPlane(store,token),data=createDataPlane(store,{health:{timeoutMs:100}}),crashes=[];
 const onCrash=error=>crashes.push(error);process.on('uncaughtException',onCrash);process.on('unhandledRejection',onCrash);
 control.listen(0,'127.0.0.1');data.listen(0,'127.0.0.1');await Promise.all([once(control,'listening'),once(data,'listening')]);
 const servers=[['control',control],['data',data]];let sent=0,rejected=0;
 try{
  for(const [name,server] of servers){
   const port=server.address().port;
   for(let i=0;i<400;i++){
    const headers={};
    if(random()<0.7)headers.authorization=pick(random,['Bearer '+token,'Bearer wrong','bearer '+token,'Basic '+text(random,20),'Bearer','',text(random,60),'Bearer '+token+' extra']);
    if(random()<0.6)headers['content-type']=pick(random,['application/json','text/plain','application/json; charset=latin1','multipart/form-data','',text(random,30)]);
    if(random()<0.2)headers['content-length']=pick(random,['-1','abc','1e3','0x10']);
    if(random()<0.2)headers['x-forwarded-for']=text(random,40);
    if(random()<0.1)headers.traceparent=text(random,60);
    const method=pick(random,methods),path=pick(random,paths),body=random()<0.6?pick(random,bodies()):undefined,result=await send(port,{method,path,headers},method==='GET'||method==='HEAD'?undefined:body);sent++;
    // A client-side protocol error (for example an invalid length header) is acceptable; a 5xx from the server is not.
    if(result.status!==undefined){assert.ok(result.status<500,`${name} ${method} ${path.slice(0,60)} -> ${result.status}`);if(result.status>=400)rejected++;}
    else assert.notEqual(result.error,'timeout',`${name} hung on ${method} ${path.slice(0,60)}`);
   }
  }
  // Still healthy and uncorrupted after the barrage.
  assert.equal((await send(data.address().port,{method:'GET',path:'/application'})).status,200);
  assert.equal((await send(control.address().port,{method:'GET',path:'/draft',headers:{authorization:'Bearer '+token}})).status,200);
  assert.equal(store.getPublished().version,1);assert.equal(store.getDraft().revision,1);assert.equal(({}).polluted,undefined);
  assert.deepEqual(crashes,[]);assert.ok(sent===800&&rejected>300,`corpus too lenient (${rejected} rejected of ${sent})`);
 }finally{process.off('uncaughtException',onCrash);process.off('unhandledRejection',onCrash);for(const [,server] of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
});
