import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {once} from 'node:events';
import {SignJWT} from 'jose';
import {CapabilityRegistry,createCapabilityServer,createJwtCapabilityAuthenticator} from '../dist/index.js';

const issuer='https://identity.example.test/',audience='https://api.example.test',time=1700000000000;
const rsa=generateKeyPairSync('rsa',{modulusLength:2048}),ec=generateKeyPairSync('ec',{namedCurve:'P-256'}),stranger=generateKeyPairSync('rsa',{modulusLength:2048}),strangerEc=generateKeyPairSync('ec',{namedCurve:'P-256'});
const jwks={keys:[{...rsa.publicKey.export({format:'jwk'}),kid:'rsa',alg:'RS256',use:'sig'},{...ec.publicKey.export({format:'jwk'}),kid:'ec',alg:'ES256',use:'sig'}]};
function rng(seed){return()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32;};}
const pick=(random,list)=>list[Math.floor(random()*list.length)];
const claims=(extra={})=>({iss:issuer,aud:audience,sub:'alice',client_id:'client',jti:'jti-'+Math.random().toString(36).slice(2),iat:time/1000,exp:time/1000+300,tenant:'tenant-a',...extra});
const sign=(payload,alg,kid,key,header={})=>new SignJWT(payload).setProtectedHeader({alg,kid,typ:'at+jwt',...header}).sign(key);
const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');

test('only a correctly signed, valid access token ever reaches a capability',{timeout:120000},async()=>{
 const random=rng(1234),audit=[];let executed=0;
 const auth=createJwtCapabilityAuthenticator({issuer,audience,jwks,maxTokenAgeSeconds:600,clock:()=>time,resolveActor:c=>c.tenant==='tenant-a'?{tenantId:c.tenant,principalId:c.sub}:undefined});
 const registry=new CapabilityRegistry(event=>audit.push(event));registry.register({operationId:'read',method:'POST',path:'/read'},{authorize:actor=>actor.tenantId==='tenant-a'&&actor.principalId==='alice',validate:()=>true,execute:()=>{executed++;return {ok:true};}});
 const failures=[],server=createCapabilityServer(registry,auth,event=>failures.push(event));server.listen(0,'127.0.0.1');await once(server,'listening');
 const url=`http://127.0.0.1:${server.address().port}/capabilities/read/invoke`,post=(authorization,body=JSON.stringify({origin:'ui',input:{}}))=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(authorization===undefined?{}:{authorization})},body});
 try{
  const good={rsa:await sign(claims(),'RS256','rsa',rsa.privateKey),ec:await sign(claims(),'ES256','ec',ec.privateKey)};
  const forged=[
   await sign(claims(),'RS256','rsa',stranger.privateKey),await sign(claims(),'ES256','ec',strangerEc.privateKey),
   await sign(claims(),'RS256','ec',rsa.privateKey),await sign(claims(),'ES256','rsa',ec.privateKey),await sign(claims(),'RS256','nope',rsa.privateKey),
   await sign(claims({exp:time/1000-1}),'RS256','rsa',rsa.privateKey),await sign(claims({iat:time/1000+3600,exp:time/1000+3900}),'RS256','rsa',rsa.privateKey),await sign(claims({iat:time/1000-7200,exp:time/1000+300}),'RS256','rsa',rsa.privateKey),
   await sign(claims({aud:'other'}),'RS256','rsa',rsa.privateKey),await sign(claims({iss:'https://evil.test/'}),'RS256','rsa',rsa.privateKey),await sign(claims({jti:undefined}),'RS256','rsa',rsa.privateKey),await sign(claims({client_id:undefined}),'RS256','rsa',rsa.privateKey),
   await sign(claims({tenant:'tenant-b'}),'RS256','rsa',rsa.privateKey),await sign(claims({sub:'mallory'}),'RS256','rsa',rsa.privateKey),
   await sign(claims(),'RS256','rsa',rsa.privateKey,{typ:'JWT'}),`${b64({alg:'RS256',kid:'rsa',typ:'at+jwt',crit:['x'],x:1})}.${b64(claims())}.${good.rsa.split('.')[2]}`,
   `${b64({alg:'none',typ:'at+jwt',kid:'rsa'})}.${b64(claims())}.`,`${b64({alg:'HS256',typ:'at+jwt',kid:'rsa'})}.${b64(claims())}.${Buffer.from('x').toString('base64url')}`,
   good.rsa.split('.').slice(0,2).join('.'),good.rsa+'.extra',good.rsa.slice(0,-4),
   good.rsa.split('.')[0]+'.'+b64(claims({sub:'alice',tenant:'tenant-b'}))+'.'+good.rsa.split('.')[2],
   good.ec.split('.')[0]+'.'+good.rsa.split('.')[1]+'.'+good.ec.split('.')[2]
  ];
  // Tamper with every character class of a good token: any single-character change must be rejected.
  const tampered=[];for(let i=0;i<good.rsa.length;i+=37){const chars=good.rsa.split('');chars[i]=chars[i]==='A'?'B':'A';tampered.push(chars.join(''));}
  const junk=[undefined,'','Bearer','Bearer ','bearer','Basic '+good.rsa,'Token '+good.rsa,'Bearer  '+good.rsa,'Bearer '+good.rsa+' x','Bearer\t'+good.rsa,'Bearer '+'a.'.repeat(5000),'Bearer '+'x'.repeat(9000),'Bearer a.b.c','Bearer ..','Bearer '+'\u0000'];
  const bodies=[undefined,'',JSON.stringify({origin:'ui',input:{}}),'{}','[]','null','{"origin":"admin","input":{}}','{"origin":"ui","input":{"__proto__":{"polluted":true}}}','\u0000'];
  let sent=0;
  for(const token of [...forged,...tampered])for(let i=0;i<3;i++){const response=await post('Bearer '+token);sent++;assert.ok([400,401,403].includes(response.status),`forged token accepted or errored: ${response.status}`);}
  for(const value of junk){let response;try{response=await post(value);}catch(error){if(error instanceof TypeError)continue;throw error;}sent++;assert.ok([400,401,403].includes(response.status),`junk authorization ${JSON.stringify(value)?.slice(0,40)} -> ${response.status}`);}
  assert.equal(executed,0,'a forged or malformed credential reached the capability');
  // Hostile bodies with a valid token are rejected or handled without a server error; and valid requests still run exactly once each.
  for(const body of bodies){const response=await post('Bearer '+await sign(claims(),'RS256','rsa',rsa.privateKey),body);sent++;assert.ok(response.status<500,`body ${JSON.stringify(body)?.slice(0,30)} -> ${response.status}`);}
  const before=executed;
  assert.equal((await post('Bearer '+good.rsa)).status,200);assert.equal((await post('Bearer '+good.ec)).status,200);
  assert.equal(executed-before,2);assert.equal(({}).polluted,undefined);assert.ok(sent>100,`corpus too small (${sent})`);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
