import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {discoverOidcJwks,createOidcJwtJwksManager} from '../dist/index.js';

// Written from a mutation run (`node scripts/mutate.mjs packages/core/dist/oidc-discovery.js ...`): each case below pins one limit or one refusal the first tests left unchecked.
const closed='http://127.0.0.1:1';// nothing listens here, so a request that passes validation fails with "discovery failed"
const valid={issuer:closed+'/',timeoutMs:500,allowLoopbackHttp:true};

test('configuration limits are exact and every invalid shape is refused before any request',async()=>{
 const refused=async(options)=>assert.rejects(discoverOidcJwks(options),/^Error: Invalid OIDC discovery configuration$/);
 const accepted=async(options)=>assert.rejects(discoverOidcJwks(options),/^Error: OIDC discovery failed$/);
 await refused(undefined);await refused(null);
 // The timeout is a safe integer from 100 to 30000 milliseconds.
 await refused({...valid,timeoutMs:99});await accepted({...valid,timeoutMs:100});await accepted({...valid,timeoutMs:30000});await refused({...valid,timeoutMs:30001});
 await refused({...valid,timeoutMs:150.5});await refused({...valid,timeoutMs:'500'});await refused({...valid,timeoutMs:undefined});await refused({...valid,timeoutMs:Number.NaN});
 // allowLoopbackHttp is a boolean or absent.
 for(const bad of ['yes',1,0,null])await refused({...valid,allowLoopbackHttp:bad});
 await refused({issuer:closed+'/',timeoutMs:500,allowLoopbackHttp:undefined});
 // allowedJwksOrigins is an array of at most 20 valid origins.
 const origins=(count)=>Array.from({length:count},(_,index)=>`https://o${index}.example`);
 await accepted({...valid,allowedJwksOrigins:origins(20)});await refused({...valid,allowedJwksOrigins:origins(21)});
 await refused({...valid,allowedJwksOrigins:'https://o.example'});await refused({...valid,allowedJwksOrigins:{length:0}});await refused({...valid,allowedJwksOrigins:null});
 await refused({...valid,allowedJwksOrigins:[42]});await refused({...valid,allowedJwksOrigins:['']});await refused({...valid,allowedJwksOrigins:['https://o.example/path']});await accepted({...valid,allowedJwksOrigins:['https://o.example/']});
});

test('issuer and origin URLs: type, length, characters, credentials, query, fragment and scheme',async()=>{
 const refused=async(options)=>assert.rejects(discoverOidcJwks(options),/^Error: Invalid OIDC discovery configuration$/);
 const accepted=async(options)=>assert.rejects(discoverOidcJwks(options),/^Error: OIDC discovery failed$/);
 for(const issuer of [undefined,null,42,{},[],'','not a url','http://127.0.0.1:1/ x','http://127.0.0.1:1/\u0000','http://127.0.0.1:1/\u007f','http://127.0.0.1:1/\t'])await refused({...valid,issuer});
 // 2,048 characters are allowed, 2,049 are not.
 const padded=(length)=>closed+'/'+'a'.repeat(length-closed.length-1);
 await accepted({...valid,issuer:padded(2048)});await refused({...valid,issuer:padded(2049)});
 // Credentials, a query and a fragment are each refused on their own.
 for(const issuer of ['http://user@127.0.0.1:1/','http://:pw@127.0.0.1:1/','http://127.0.0.1:1/?a=1','http://127.0.0.1:1/#top'])await refused({...valid,issuer});
 for(const origin of ['https://user@o.example','https://:pw@o.example','https://o.example?a=1','https://o.example#top'])await refused({...valid,allowedJwksOrigins:[origin]});
 // https is always fine; http only for the three loopback names and only when allowed.
 await accepted({...valid,issuer:'https://127.0.0.1:1/'});
 for(const host of ['localhost','127.0.0.1','[::1]'])await accepted({...valid,issuer:`http://${host}:1/`});
 for(const host of ['127.0.0.2','example.com','localhost.example','[::2]'])await refused({...valid,issuer:`http://${host}:1/`});
 await refused({...valid,allowLoopbackHttp:false,issuer:'http://127.0.0.1:1/'});await refused({...valid,issuer:'ftp://127.0.0.1:1/'});await refused({...valid,issuer:'ws://127.0.0.1:1/'});
 await refused({...valid,allowLoopbackHttp:false,allowedJwksOrigins:['http://127.0.0.1:1']});await accepted({...valid,allowedJwksOrigins:['http://127.0.0.1:1']});
});

test('metadata responses: status, content type, size, encoding and shape',async()=>{
 let status=200,type='application/json',body='',requests=0;
 const server=createServer((_req,res)=>{requests+=1;res.writeHead(status,type===null?{}:{'content-type':type});res.end(body);});server.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}`,issuer=base+'/',opts={issuer,timeoutMs:2000,allowLoopbackHttp:true};
 const good=JSON.stringify({issuer,jwks_uri:base+'/keys'});
 const fails=async()=>assert.rejects(discoverOidcJwks(opts),/^Error: OIDC discovery failed$/);
 try{
  body=good;
  // A successful status is required even when the body is valid metadata.
  for(const code of [500,404,403]){status=code;await fails();}
  status=200;
  // The content type must be application/json exactly, optionally followed by parameters.
  for(const accepted of ['application/json','application/json; charset=utf-8','application/json;charset=utf-8','APPLICATION/JSON'])assert.deepEqual(await (type=accepted,discoverOidcJwks(opts)),{issuer,jwksUrl:base+'/keys'});
  for(const bad of ['application/jsonx','application/json-seq','text/json','xapplication/json','text/plain',''])await (type=bad,fails());
  type=null;await fails();type='application/json';
  // No body at all is refused.
  status=204;await fails();status=200;
  // The size limit is 128 KiB of bytes: exactly that is read, one byte more is refused.
  const pad=(total)=>good+' '.repeat(total-Buffer.byteLength(good));
  body=pad(128*1024);assert.equal((await discoverOidcJwks(opts)).jwksUrl,base+'/keys');
  body=pad(128*1024+1);await fails();
  // Invalid UTF-8 is refused instead of being repaired with replacement characters.
  body=Buffer.concat([Buffer.from(`{"issuer":"${issuer}","jwks_uri":"${base}/keys","note":"`),Buffer.from([0xff,0xfe]),Buffer.from('"}')]);await fails();
  body=good;assert.equal((await discoverOidcJwks(opts)).issuer,issuer);
  // Anything but a JSON object is refused.
  for(const shape of ['null','42','"text"','true','[]','[{"issuer":"x"}]','{"jwks_uri":"'+base+'/keys"}','{"issuer":"'+issuer+'"}','{"issuer":"'+issuer+'","jwks_uri":42}','{"issuer":42,"jwks_uri":"'+base+'/keys"}']){body=shape;await fails();}
  assert.ok(requests>0);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('the manager refuses a missing or incomplete authenticator before any request',async()=>{
 let requests=0;const originalFetch=globalThis.fetch;globalThis.fetch=()=>{requests+=1;return Promise.reject(new Error('no request expected'));};
 try{
  const mismatch=async(options)=>assert.rejects(createOidcJwtJwksManager(options),/^Error: OIDC issuer mismatch$/);
  await mismatch(undefined);await mismatch(null);await mismatch({});
  await mismatch({...valid,authenticator:{}});await mismatch({...valid,authenticator:{isIssuer:'yes'}});
  await mismatch({...valid,authenticator:{isIssuer:()=>false}});await mismatch({...valid,authenticator:{isIssuer:()=>undefined}});
  assert.equal(requests,0);
 }finally{globalThis.fetch=originalFetch;}
});
