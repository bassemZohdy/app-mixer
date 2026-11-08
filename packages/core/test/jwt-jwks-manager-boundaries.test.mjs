import test from 'node:test';
import assert from 'node:assert/strict';
import {JwtJwksManager} from '../dist/index.js';

// Written from a mutation run (`node scripts/mutate.mjs packages/core/dist/jwt-jwks-manager.js ...`): each case pins one limit, one skipped key kind or one refusal that the first tests left unchecked.
const url='https://issuer.example/keys';
const fakeAuth=()=>{const calls={replace:[],close:0},auth=async()=>({tenantId:'tenant',principalId:'user'});auth.replaceKeys=keys=>{calls.replace.push(keys);};auth.close=()=>{calls.close+=1;};auth.calls=calls;return auth;};
const make=(auth,extra={})=>new JwtJwksManager({authenticator:auth,jwksUrl:url,pollMs:100,maxStaleMs:1000,timeoutMs:500,onError:()=>{},...extra});
const reply=(body,{type='application/json',status=200}={})=>new Response(body,{status,headers:type===null?{}:{'content-type':type}});
const stubFetch=responder=>{const original=globalThis.fetch,calls=[];globalThis.fetch=async(target,init)=>{calls.push({target,init});return responder(target,init,calls.length);};return {calls,restore:()=>{globalThis.fetch=original;}};};
const ec=(kid,extra={})=>({kty:'EC',crv:'P-256',x:'x',y:'y',kid,...extra});
const rsa=(kid,bytes=256,extra={})=>({kty:'RSA',n:Buffer.alloc(bytes,1).toString('base64url'),e:'AQAB',kid,...extra});
// Install a key set through a fresh manager and report the key ids it kept, or that the refresh failed.
const outcome=async(value)=>{
 const auth=fakeAuth(),stub=stubFetch(()=>reply(typeof value==='string'?value:JSON.stringify(value))),m=make(auth);
 try{await m.refresh();return auth.calls.replace[0].keys.map(key=>key.kid);}
 catch(error){assert.equal(error.message,'JWKS refresh failed');assert.equal(auth.calls.replace.length,0);return error.cause.message;}
 finally{stub.restore();await m.close();}
};

test('a key set holds 1 to 100 keys and must be an object with a keys array',async()=>{
 const many=count=>({keys:Array.from({length:count},(_,index)=>ec('k'+index))});
 assert.equal(await outcome({keys:[]}),'Invalid JWKS');
 assert.deepEqual(await outcome(many(1)),['k0']);
 assert.equal((await outcome(many(100))).length,100);
 assert.equal(await outcome(many(101)),'Invalid JWKS');
 for(const bad of ['null','[]','[{"keys":[]}]','"keys"','42','{}','{"keys":{"length":1}}','{"keys":"abc"}','{"keys":null}'])assert.equal(await outcome(bad),'Invalid JWKS',bad);
 assert.match(await outcome({keys:[{kty:'OKP',kid:'o'}]}),/^No compatible JWKS keys$/);
});

test('a malformed key fails the whole refresh instead of being skipped',async()=>{
 const keep=ec('keep');
 for(const key of [null,[],'text',42,{},{kty:42},{kty:''},{kty:null}])assert.equal(await outcome({keys:[keep,key]}),'Invalid JWKS',JSON.stringify(key));
 // Private or symmetric key material is never accepted, whatever the key type.
 for(const name of ['d','p','q','dp','dq','qi','oth','k'])assert.equal(await outcome({keys:[keep,ec('p',{[name]:'secret'})]}),'Invalid JWKS',name);
 for(const name of ['d','k'])assert.equal(await outcome({keys:[keep,{kty:'OKP',kid:'o',[name]:'secret'}]}),'Invalid JWKS',name);
 // `use` is sig or enc; `alg` is a short non-empty string; `key_ops` is a short list of distinct strings.
 for(const use of ['verify','',null,42,'SIG'])assert.equal(await outcome({keys:[keep,ec('u',{use})]}),'Invalid JWKS',String(use));
 assert.deepEqual(await outcome({keys:[keep,ec('e',{use:'enc'})]}),['keep']);
 for(const alg of ['',42,null,{},[],'a'.repeat(129)])assert.equal(await outcome({keys:[keep,ec('a',{alg})]}),'Invalid JWKS',String(alg));
 assert.deepEqual(await outcome({keys:[keep,ec('a',{alg:'a'.repeat(128)})]}),['keep']);
 const ops=count=>Array.from({length:count},(_,index)=>'op'+index);
 assert.deepEqual(await outcome({keys:[keep,ec('o',{key_ops:ops(16)})]}),['keep']);
 for(const key_ops of [ops(17),'verify',{length:1},null,[1],['verify',null],['verify','verify']])assert.equal(await outcome({keys:[keep,ec('o',{key_ops})]}),'Invalid JWKS',JSON.stringify(key_ops));
});

test('only RS256 and ES256 signature keys that may verify are kept',async()=>{
 const kept=async(...keys)=>outcome({keys:[ec('keep'),...keys]});
 assert.deepEqual(await kept(rsa('r'),ec('e2',{use:'sig',alg:'ES256',key_ops:['verify']}),rsa('r2',256,{use:'sig',alg:'RS256',key_ops:['verify']})),['keep','r','e2','r2']);
 // Skipped, not failed: another use, another algorithm, another curve, another key type, or key operations that cannot verify.
 assert.deepEqual(await kept(rsa('r1',256,{use:'enc'}),rsa('r2',256,{alg:'RS384'}),rsa('r3',256,{alg:'ES256'}),rsa('r4',256,{key_ops:['sign']}),rsa('r5',256,{key_ops:[]})),['keep']);
 assert.deepEqual(await kept(ec('e1',{use:'enc'}),ec('e2',{alg:'ES384'}),ec('e3',{alg:'RS256'}),ec('e4',{crv:'P-384'}),ec('e5',{crv:undefined}),ec('e6',{key_ops:['sign']}),ec('e7',{key_ops:[]}),{kty:'oct',kid:'o'},{kty:'OKP',crv:'Ed25519',kid:'ed'}),['keep']);
 // RSA keys with an elliptic-curve curve, and elliptic-curve keys with an RSA algorithm, are not mixed up.
 assert.deepEqual(await kept(rsa('r',256,{crv:'P-256'}),ec('e',{n:'abc'})),['keep','r','e']);
 // A key with more than one operation is outside what the authenticator supports and is left out.
 assert.deepEqual(await kept(ec('m',{key_ops:['verify','sign']}),rsa('m2',256,{key_ops:['verify','sign']})),['keep']);
});

test('keys the authenticator does not support are left out one by one',async()=>{
 const kept=async(...keys)=>outcome({keys:[ec('keep'),...keys]});
 // key ids: a non-empty string of at most 128 characters, used once (the first one wins).
 for(const kid of [undefined,'',42,null,['a'],'a'.repeat(129)])assert.deepEqual(await kept(ec(kid),rsa(kid)),['keep'],String(kid));
 assert.deepEqual(await kept(ec('a'.repeat(128))),['keep','a'.repeat(128)]);
 assert.deepEqual(await kept(ec('dup'),ec('dup',{x:'other'}),rsa('dup'),ec('keep')),['keep','dup']);
 const auth=fakeAuth(),stub=stubFetch(()=>reply(JSON.stringify({keys:[ec('dup',{x:'first'}),ec('dup',{x:'second'})]})));const m=make(auth);
 try{await m.refresh();assert.equal(auth.calls.replace[0].keys.length,1);assert.equal(auth.calls.replace[0].keys[0].x,'first');}finally{stub.restore();await m.close();}
 // RSA: the exponent must be 65537, and a modulus of 1,024 to 2,040 bits is left out (127 bytes and 256 bytes are not).
 assert.deepEqual(await kept(rsa('e1',256,{e:'Aw'}),rsa('e2',256,{e:''}),rsa('e3',256,{e:null}),rsa('e4',256,{e:65537})),['keep']);
 const noExponent=rsa('noe');delete noExponent.e;assert.deepEqual(await kept(noExponent),['keep','noe']);
 assert.deepEqual(await kept(rsa('b127',127),rsa('b128',128),rsa('b129',129),rsa('b255',255),rsa('b256',256),rsa('b257',257),rsa('b512',512)),['keep','b127','b256','b257','b512']);
 // A modulus that is not base64url text, or not text, is not judged by size.
 assert.deepEqual(await kept(rsa('n1',256,{n:'a+b/'+'A'.repeat(200)}),rsa('n2',256,{n:42}),rsa('n3',256,{n:''}),{...rsa('n4'),n:undefined}),['keep','n1','n2','n3','n4']);
 // Elliptic-curve keys are not subject to the RSA rules.
 assert.deepEqual(await kept(ec('x1',{e:'Aw',n:Buffer.alloc(200).toString('base64url')})),['keep','x1']);
});

test('constructor limits are exact and every invalid shape is refused',()=>{
 const refused=extra=>assert.throws(()=>make(fakeAuth(),extra),/^Error: Invalid JWKS manager configuration$/);
 const accepted=async extra=>{const m=make(fakeAuth(),extra);await m.close();};
 assert.throws(()=>new JwtJwksManager(undefined),/configuration/);assert.throws(()=>new JwtJwksManager(null),/configuration/);
 // The authenticator needs to be callable with replaceKeys and close.
 const partial=(missing)=>{const auth=fakeAuth();if(missing)auth[missing]=undefined;return auth;};
 for(const missing of ['replaceKeys','close'])assert.throws(()=>make(partial(missing)),/configuration/,missing);
 for(const authenticator of [undefined,null,{},{replaceKeys(){},close(){}}])assert.throws(()=>new JwtJwksManager({authenticator,jwksUrl:url,pollMs:100,maxStaleMs:1000,timeoutMs:500,onError(){}}),/configuration/);
 const nonFunction=fakeAuth();nonFunction.replaceKeys='yes';assert.throws(()=>make(nonFunction),/configuration/);
 // The URL is a string of at most 2,048 characters.
 const padded=length=>url+'/'+'a'.repeat(length-url.length-1);
 return Promise.all([accepted({jwksUrl:padded(2048)})]).then(async()=>{
  refused({jwksUrl:padded(2049)});for(const jwksUrl of [undefined,null,42,{},'','not a url'])refused({jwksUrl});
  // poll interval 100 ms to one hour; staleness limit from the poll interval to one day; request timeout 100 ms to 30 s.
  refused({pollMs:99});await accepted({pollMs:100});await accepted({pollMs:3600000,maxStaleMs:3600000});refused({pollMs:3600001,maxStaleMs:86400000});
  refused({pollMs:150.5});refused({pollMs:'100'});refused({pollMs:-100});refused({pollMs:undefined});refused({pollMs:Number.NaN});
  refused({maxStaleMs:99});refused({maxStaleMs:1000,pollMs:1001});await accepted({maxStaleMs:100});await accepted({maxStaleMs:86400000});refused({maxStaleMs:86400001});
  refused({maxStaleMs:1000.5});refused({maxStaleMs:'1000'});refused({maxStaleMs:undefined});
  refused({timeoutMs:99});await accepted({timeoutMs:100});await accepted({timeoutMs:30000});refused({timeoutMs:30001});refused({timeoutMs:500.5});refused({timeoutMs:'500'});refused({timeoutMs:undefined});
  for(const onError of [undefined,null,'log',{}])refused({onError});
  for(const allowLoopbackHttp of ['yes',1,0,null])refused({allowLoopbackHttp});
  for(const clock of [null,'now',42,{}])refused({clock});await accepted({clock:()=>1});await accepted({allowLoopbackHttp:false});await accepted({allowLoopbackHttp:undefined,clock:undefined});
  // https is required, except plain http to a loopback name when allowed; credentials, a query and a fragment are refused one by one.
  for(const jwksUrl of ['http://issuer.example/keys','http://127.0.0.2/keys','http://localhost.example/keys','ftp://localhost/keys','https://user@issuer.example/keys','https://:pw@issuer.example/keys','https://issuer.example/keys?a=1','https://issuer.example/keys#top'])refused({jwksUrl,allowLoopbackHttp:true});
  for(const host of ['localhost','127.0.0.1','[::1]']){refused({jwksUrl:`http://${host}/keys`});refused({jwksUrl:`http://${host}/keys`,allowLoopbackHttp:false});await accepted({jwksUrl:`http://${host}/keys`,allowLoopbackHttp:true});}
 });
});

test('the request and the response are checked before any key is installed',async()=>{
 const good=JSON.stringify({keys:[ec('k')]}),fails=async(response)=>{const auth=fakeAuth(),stub=stubFetch(()=>response()),m=make(auth);try{await assert.rejects(m.refresh(),/^Error: JWKS refresh failed$/);assert.equal(auth.calls.replace.length,0);assert.equal(await m.authenticate({}),undefined);}finally{stub.restore();await m.close();}};
 let auth=fakeAuth(),stub=stubFetch(()=>reply(good)),m=make(auth,{timeoutMs:777});
 try{await m.refresh();const [call]=stub.calls;assert.equal(call.target,url);assert.equal(call.init.method,'GET');assert.equal(call.init.redirect,'error');assert.deepEqual(call.init.headers,{accept:'application/json'});assert.ok(call.init.signal instanceof AbortSignal);}finally{stub.restore();await m.close();}
 // A success status, a JSON content type and a body are all required.
 for(const status of [500,404,403])await fails(()=>reply(good,{status}));
 for(const type of ['application/jsonx','application/json-seq','application/jwk-set+jsonx','text/json','text/plain','xapplication/json','',null])await fails(()=>reply(good,{type}));
 await fails(()=>new Response(null,{status:204,headers:{'content-type':'application/json'}}));
 for(const type of ['application/json','application/json; charset=utf-8','application/jwk-set+json','APPLICATION/JWK-SET+JSON;x=1','application/json;charset=utf-8']){auth=fakeAuth();stub=stubFetch(()=>reply(good,{type}));m=make(auth);try{await m.refresh();assert.equal(auth.calls.replace.length,1,type);}finally{stub.restore();await m.close();}}
 // At most 128 KiB is read: exactly that is fine, one byte more is not.
 const pad=total=>good+' '.repeat(total-Buffer.byteLength(good));
 auth=fakeAuth();stub=stubFetch(()=>reply(pad(128*1024)));m=make(auth);try{await m.refresh();assert.equal(auth.calls.replace.length,1);}finally{stub.restore();await m.close();}
 await fails(()=>reply(pad(128*1024+1)));
 // Invalid UTF-8, text that is not JSON, and a failing network request leave the key set untouched.
 await fails(()=>reply(Buffer.concat([Buffer.from('{"keys":[{"kty":"EC","crv":"P-256","kid":"k","note":"'),Buffer.from([0xff,0xfe]),Buffer.from('"}]}')])));
 await fails(()=>reply('not json'));
 const network=make(fakeAuth()),failing=stubFetch(()=>{throw new TypeError('network down');});try{await assert.rejects(network.refresh(),error=>error.message==='JWKS refresh failed'&&error.cause.message==='network down');}finally{failing.restore();await network.close();}
});

test('freshness: keys serve requests for less than the staleness limit and never from the future',async()=>{
 let now=1000;const auth=fakeAuth(),stub=stubFetch(()=>reply(JSON.stringify({keys:[ec('k')]}))),m=make(auth,{clock:()=>now,maxStaleMs:500});
 try{
  assert.equal(await m.authenticate({}),undefined,'no keys yet');
  await m.refresh();
  assert.ok(await m.authenticate({}));now=1499;assert.ok(await m.authenticate({}),'one millisecond before the limit');
  now=1500;assert.equal(await m.authenticate({}),undefined,'at the limit');now=2000;assert.equal(await m.authenticate({}),undefined);
  now=999;assert.equal(await m.authenticate({}),undefined,'a clock earlier than the refresh');now=1000;assert.ok(await m.authenticate({}),'at the refresh time');
  // A clock that is not a whole non-negative number fails closed in both paths.
  for(const bad of [1.5,-1,Number.NaN,'1000',undefined,null]){now=bad;assert.equal(await m.authenticate({}),undefined,String(bad));await assert.rejects(m.refresh(),/^Error: JWKS refresh failed$/);}
 }finally{stub.restore();await m.close();}
});

test('a request is refused when the key set goes stale, changes or closes while its identity is being mapped',async()=>{
 let now=1000,release,entered;const gate=()=>new Promise(resolve=>{release=resolve;}),auth=fakeAuth(),stub=stubFetch(()=>reply(JSON.stringify({keys:[ec('k')]})));
 const slow=async()=>{entered();await gate();return {tenantId:'tenant',principalId:'user'};};
 const m=make(Object.assign(slow,{replaceKeys:auth.replaceKeys,close:auth.close}),{clock:()=>now,maxStaleMs:500});
 const run=async(during)=>{const started=new Promise(resolve=>{entered=resolve;}),pending=m.authenticate({});await started;await during();release();return pending;};
 try{
  await m.refresh();
  assert.ok(await run(async()=>{now=1499;}),'still fresh when the mapping finishes');
  assert.equal(await run(async()=>{now=1500;}),undefined,'stale when the mapping finishes');
  now=1100;await m.refresh();
  // The same document again keeps the key set and extends its life, so a request that started earlier is still served while it stays fresh...
  assert.ok(await run(async()=>{now=1200;await m.refresh();}));
  // ...but not when the clock moved past the limit of the key set it started with, even though a newer refresh succeeded meanwhile.
  assert.equal(await run(async()=>{now=1700;await m.refresh();}),undefined);
  // A refresh that changes the key set fences the request.
  now=1700;await m.refresh();
  stub.restore();const changed=stubFetch(()=>reply(JSON.stringify({keys:[ec('other')]})));
  try{assert.equal(await run(async()=>{await m.refresh();}),undefined);}finally{changed.restore();}
  // The clock going backwards while mapping does not serve the request.
  const again=stubFetch(()=>reply(JSON.stringify({keys:[ec('other')]})));try{now=2000;await m.refresh();assert.equal(await run(async()=>{now=1999;}),undefined);}finally{again.restore();}
  // A manager closed meanwhile refuses it.
  now=2000;const last=stubFetch(()=>reply(JSON.stringify({keys:[ec('other')]})));try{assert.equal(await run(async()=>{await m.close();}),undefined);}finally{last.restore();}
 }finally{release?.();await m.close();}
});

test('an unchanged document does not replace the keys but still renews their life',async()=>{
 let now=1000,body=JSON.stringify({keys:[ec('k')]});const auth=fakeAuth(),stub=stubFetch(()=>reply(body)),m=make(auth,{clock:()=>now,maxStaleMs:500});
 try{
  await m.refresh();assert.equal(auth.calls.replace.length,1);
  now=1400;await m.refresh();assert.equal(auth.calls.replace.length,1,'same document');now=1800;assert.ok(await m.authenticate({}),'renewed at 1400');
  // The same keys in a different spelling are a different document.
  body=JSON.stringify({keys:[ec('k')]},null,1);await m.refresh();assert.equal(auth.calls.replace.length,2);
  body=JSON.stringify({keys:[ec('k2')]});await m.refresh();assert.equal(auth.calls.replace.length,3);assert.deepEqual(auth.calls.replace[2].keys.map(key=>key.kid),['k2']);
  // A failed refresh keeps the previous keys and does not renew them.
  body='not json';now=2000;await assert.rejects(m.refresh(),/failed/);assert.equal(auth.calls.replace.length,3);now=2299;assert.ok(await m.authenticate({}));now=2300;assert.equal(await m.authenticate({}),undefined);
 }finally{stub.restore();await m.close();}
});

test('refresh calls share one request, and a closed or stopped manager installs nothing',async()=>{
 let release;const auth=fakeAuth(),stub=stubFetch(()=>new Promise(resolve=>{release=()=>resolve(reply(JSON.stringify({keys:[ec('k')]})));})),m=make(auth);
 try{
  const first=m.refresh(),second=m.refresh();assert.equal(first,second,'a refresh in flight is shared');assert.equal(stub.calls.length,1);
  // Stopping while the request is in flight cancels the refresh even though the response arrives.
  const stopping=m.stop();release();await stopping;await assert.rejects(first,error=>error.message==='JWKS refresh failed'&&error.cause.message==='JWKS refresh cancelled');
  assert.equal(auth.calls.replace.length,0);assert.equal(await m.authenticate({}),undefined);
  // The next refresh is a new request and works.
  const third=m.refresh();assert.notEqual(third,first);assert.equal(stub.calls.length,2);release();await third;assert.equal(auth.calls.replace.length,1);
  // Closing while a request is in flight cancels it too, and closing twice closes the authenticator once.
  const fourth=m.refresh();const closing=m.close();assert.equal(m.close(),closing);release();await closing;await assert.rejects(fourth,/failed/);
  assert.equal(auth.calls.replace.length,1);assert.equal(auth.calls.close,1);
  assert.throws(()=>m.refresh(),/^Error: JWKS manager closed$/);assert.throws(()=>m.start(),/^Error: JWKS manager unavailable$/);
  assert.equal(await m.authenticate({}),undefined);
 }finally{stub.restore();await m.close();}
});

test('the polling loop refreshes on its interval, reports failures and stops cleanly',async()=>{
 let fail=false;const errors=[],auth=fakeAuth(),stub=stubFetch(()=>fail?reply('not json'):reply(JSON.stringify({keys:[ec('k')]}))),m=make(auth,{pollMs:100,maxStaleMs:1000,onError:error=>{errors.push(error.message);throw new Error('a failing handler must not stop the loop');}});
 const until=async(condition)=>{for(let i=0;i<200&&!condition();i++)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(condition(),'timed out');};
 try{
  m.start();assert.throws(()=>m.start(),/^Error: JWKS manager unavailable$/);
  await until(()=>stub.calls.length>=3);assert.deepEqual(errors,[]);assert.equal(auth.calls.replace.length,1,'the same document is installed once');
  fail=true;await until(()=>errors.length>=2);assert.equal(errors[0],'JWKS refresh failed');
  const count=stub.calls.length,reported=errors.length;await m.stop();await new Promise(resolve=>setTimeout(resolve,300));assert.equal(stub.calls.length,count,'no request after stop');assert.equal(errors.length,reported,'no report after stop');
  // A stopped manager can start again; a failing refresh in flight at stop time is not reported.
  fail=false;m.start();await until(()=>stub.calls.length>count);
  fail=true;let release;stub.restore();const hanging=stubFetch(()=>new Promise((_resolve,reject)=>{release=()=>reject(new Error('aborted'));}));
  try{await m.stop();const before=errors.length;m.start();await until(()=>release!==undefined);const stopping=m.stop();release();await stopping;await new Promise(resolve=>setTimeout(resolve,50));assert.equal(errors.length,before,'a refresh cancelled by stop is not an error to report');}finally{hanging.restore();}
 }finally{await m.close();}
});
