// Staged submissions against a real external provider: an S3-compatible object store (SeaweedFS) in Docker, reached
// with signed requests through a TCP proxy that can lose the response or the request. Opt-in: APP_MIXER_TEST_S3=docker.
// The provider's create-only write (If-None-Match: *) keyed by the staged idempotency key is what makes duplicates
// impossible; the verifier reads the provider directly after an ambiguous result.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash,createHmac} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {createServer,connect} from 'node:net';
import {CapabilityRegistry,SqliteStagedOperations} from '../dist/index.js';

const enabled=process.env.APP_MIXER_TEST_S3==='docker';
const image='chrislusf/seaweedfs:4.50@sha256:c2658820e763294a9e9de7b36c81e59b879e3459148351aee4e31a126ca64860';
const access='appmixer',secret='appmixer-test-secret',bucket='staged-orders',region='us-east-1';
const scope={tenantId:'tenant',applicationId:'app'},context={tenantId:'tenant',principalId:'operator',origin:'ui'};
const docker=args=>new Promise((resolve,reject)=>execFile('docker',args,{timeout:180000,maxBuffer:4*1024*1024},(error,stdout,stderr)=>error?reject(Object.assign(error,{stderr})):resolve(stdout.trim())));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const freePort=()=>new Promise((resolve,reject)=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>resolve(port));});server.on('error',reject);});

// AWS Signature Version 4, enough for path-style S3 requests.
const sha256=value=>createHash('sha256').update(value).digest('hex'),hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
const encodeKey=key=>key.split('/').map(part=>encodeURIComponent(part)).join('/');
function signed({method,host,path,query={},body='',headers={}}){
 const stamp=new Date().toISOString().replace(/[-:]|\.\d{3}/g,''),day=stamp.slice(0,8),payloadHash=sha256(body);
 const all={...Object.fromEntries(Object.entries(headers).map(([name,value])=>[name.toLowerCase(),value])),host,'x-amz-content-sha256':payloadHash,'x-amz-date':stamp};
 const names=Object.keys(all).sort(),canonicalQuery=Object.keys(query).sort().map(name=>encodeURIComponent(name)+'='+encodeURIComponent(query[name])).join('&');
 const canonical=[method,path,canonicalQuery,names.map(name=>name+':'+String(all[name]).trim()+'\n').join(''),names.join(';'),payloadHash].join('\n');
 const credentialScope=`${day}/${region}/s3/aws4_request`,toSign=['AWS4-HMAC-SHA256',stamp,credentialScope,sha256(canonical)].join('\n');
 const signingKey=hmac(hmac(hmac(hmac('AWS4'+secret,day),region),'s3'),'aws4_request');
 return {headers:{...all,authorization:`AWS4-HMAC-SHA256 Credential=${access}/${credentialScope}, SignedHeaders=${names.join(';')}, Signature=${createHmac('sha256',signingKey).update(toSign).digest('hex')}`},query:canonicalQuery};
}
// One request on a fresh connection to `port`, signed for the provider's own host, with a client-side deadline.
function s3(port,host,{method,path,query,body,headers,timeoutMs=5000}){
 const signedRequest=signed({method,host,path,query,body,headers});
 return new Promise((resolve,reject)=>{
  const req=httpRequest({host:'127.0.0.1',port,method,path:path+(signedRequest.query?'?'+signedRequest.query:''),headers:signedRequest.headers,agent:false,timeout:timeoutMs},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:text}));});
  req.on('timeout',()=>req.destroy(Object.assign(Error('provider request timed out'),{code:'ETIMEDOUT'})));req.on('error',reject);req.end(body);
 });
}

// A TCP proxy in front of the provider. 'pass' forwards both ways; 'lose-response' forwards the request and lets the
// provider answer, but never returns that answer to the client; 'lose-request' closes the connection before
// forwarding anything.
async function faultyProxy(upstreamPort){
 const state={mode:'pass',forwarded:0,heldResponses:0,dropped:0,sockets:new Set()};
 const server=createServer(client=>{
  state.sockets.add(client);client.on('close',()=>state.sockets.delete(client));client.on('error',()=>{});
  if(state.mode==='lose-request'){state.dropped++;client.destroy();return;}
  const upstream=connect(upstreamPort,'127.0.0.1');state.sockets.add(upstream);upstream.on('close',()=>state.sockets.delete(upstream));upstream.on('error',()=>client.destroy());
  const mode=state.mode;client.on('data',chunk=>{state.forwarded++;upstream.write(chunk);});client.on('close',()=>{if(mode==='pass')upstream.destroy();});
  upstream.on('data',chunk=>{if(mode==='lose-response'){state.heldResponses++;return;}client.write(chunk);});upstream.on('end',()=>{if(mode==='pass')client.end();});
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {state,port:server.address().port,close:()=>new Promise(resolve=>{for(const socket of state.sockets)socket.destroy();server.close(resolve);})};
}

test('staged submissions reconcile an ambiguous timeout against a real S3 provider without a duplicate effect',{skip:!enabled&&'set APP_MIXER_TEST_S3=docker to run against a SeaweedFS container',timeout:300000},async()=>{
 const providerPort=await freePort(),name='app-mixer-s3-'+process.pid+'-'+Date.now(),host='127.0.0.1:'+providerPort;let proxy,staged;
 await docker(['run','-d','--rm','--name',name,'-p',`127.0.0.1:${providerPort}:8333`,image,'server','-s3','-dir=/data']);
 try{
  // Wait for the S3 gateway, require credentials, then create the bucket with a signed request.
  for(let i=0;;i++){try{const response=await s3(providerPort,host,{method:'GET',path:'/',timeoutMs:2000});if(response.status)break;}catch(error){if(i>90)throw error;}await sleep(1000);}
  await docker(['exec',name,'sh','-c',`echo "s3.configure -access_key=${access} -secret_key=${secret} -user=app -actions=Read,Write,List,Admin -apply" | weed shell`]);
  for(let i=0;;i++){const anonymous=await new Promise((resolve,reject)=>{const req=httpRequest({host:'127.0.0.1',port:providerPort,method:'PUT',path:'/anonymous-probe',agent:false},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});if(anonymous===403)break;if(i>30)throw Error('provider still accepts anonymous requests');await sleep(1000);}
  assert.equal((await s3(providerPort,host,{method:'PUT',path:'/'+bucket})).status,200);
  proxy=await faultyProxy(providerPort);
  const objectPath=key=>`/${bucket}/${encodeKey('orders/'+key)}`;
  const listOrders=async()=>{const response=await s3(providerPort,host,{method:'GET',path:'/'+bucket,query:{'list-type':'2',prefix:'orders/'}});assert.equal(response.status,200);return [...response.body.matchAll(/<Key>([^<]+)<\/Key>/g)].map(match=>match[1]).sort();};

  // The capability places an order as a create-only object named by the idempotency key. A 412 means an earlier
  // attempt already created it; the stored body must then be the same order.
  const registry=new CapabilityRegistry(()=>{}),attempts=[];
  registry.register({operationId:'orders.place',method:'POST',path:'/orders'},{authorize:()=>true,validate:input=>typeof input.idempotencyKey==='string'&&Number.isSafeInteger(input.payload.quantity),execute:async input=>{
   const body=JSON.stringify(input.payload);attempts.push(input.idempotencyKey);
   const response=await s3(proxy.port,host,{method:'PUT',path:objectPath(input.idempotencyKey),body,headers:{'content-type':'application/json','if-none-match':'*'},timeoutMs:1500});
   if(response.status===200)return {created:true};
   if(response.status===412){const existing=await s3(proxy.port,host,{method:'GET',path:objectPath(input.idempotencyKey)});if(existing.status===200&&existing.body===body)return {created:false};throw Error('Idempotency key reused for a different order');}
   throw Error('Provider rejected the order: '+response.status);
  }});
  // The verifier asks the provider directly. Applied needs the stored order to match. Not applied needs no object
  // and the lost attempt's connection closed for longer than the provider takes to process a received request.
  const settleMs=2000,closedAt=new Map();
  const verify=async(_scope,operation)=>{
   const found=await s3(providerPort,host,{method:'GET',path:objectPath(operation.idempotencyKey)});
   if(found.status===200)return found.body===JSON.stringify(operation.payload)?'applied':'unknown';
   if(found.status===404&&closedAt.has(operation.id)&&Date.now()-closedAt.get(operation.id)>=settleMs)return 'not_applied';
   return 'unknown';
  };
  staged=new SqliteStagedOperations(':memory:');

  // 1. Ambiguous timeout after the effect: the provider stores the order, the response is lost, the client times out.
  const first=staged.stage(scope,'orders.place',{sku:'A-1',quantity:2},'order-1');
  proxy.state.mode='lose-response';
  await assert.rejects(staged.submit(scope,first.id,registry,context),/timed out/);
  // The provider may finish after the client has given up (its first write allocates storage); wait for its answer.
  for(let i=0;proxy.state.heldResponses===0;i++){if(i>100)assert.fail('the provider never answered');await sleep(100);}
  assert.ok(proxy.state.forwarded>0,'the request reached the provider and its answer was lost');
  assert.equal(staged.get(scope,first.id).status,'uncertain');
  await assert.rejects(staged.submit(scope,first.id,registry,context),/not staged/,'an uncertain intent is never retried automatically');
  assert.deepEqual(await listOrders(),['orders/'+first.idempotencyKey],'the effect happened exactly once');
  proxy.state.mode='pass';
  assert.equal(await staged.verifyAndReconcile(scope,first.id,verify),'applied');assert.equal(staged.get(scope,first.id).status,'succeeded');
  // Even a buggy extra execution with the same key cannot duplicate the order: the provider refuses the second create.
  assert.deepEqual(await registry.invoke('orders.place',{idempotencyKey:first.idempotencyKey,payload:{sku:'A-1',quantity:2}},context),{created:false});
  await assert.rejects(registry.invoke('orders.place',{idempotencyKey:first.idempotencyKey,payload:{sku:'A-1',quantity:9}},context),/different order/);
  assert.deepEqual(await listOrders(),['orders/'+first.idempotencyKey]);

  // 2. Lost request: the connection fails before anything reaches the provider. Verification waits out the settle
  // period, finds nothing, reconciles not applied, and an explicit resubmission with the same key creates the order once.
  const second=staged.stage(scope,'orders.place',{sku:'B-2',quantity:1},'order-2');
  proxy.state.mode='lose-request';
  await assert.rejects(staged.submit(scope,second.id,registry,context));closedAt.set(second.id,Date.now());
  assert.equal(proxy.state.dropped,1);assert.equal(staged.get(scope,second.id).status,'uncertain');
  assert.equal(await staged.verifyAndReconcile(scope,second.id,verify),'unknown','too early to rule out a late effect');assert.equal(staged.get(scope,second.id).status,'uncertain');
  await sleep(settleMs);
  assert.equal(await staged.verifyAndReconcile(scope,second.id,verify),'not_applied');assert.equal(staged.get(scope,second.id).status,'staged');
  proxy.state.mode='pass';
  assert.deepEqual(await staged.submit(scope,second.id,registry,context),{created:true});assert.equal(staged.get(scope,second.id).status,'succeeded');
  assert.deepEqual(await listOrders(),['orders/'+first.idempotencyKey,'orders/'+second.idempotencyKey].sort());

  // 3. Ambiguous timeout on the resubmission path too: a lost response after not_applied still yields one order.
  const third=staged.stage(scope,'orders.place',{sku:'C-3',quantity:5},'order-3');
  proxy.state.mode='lose-request';await assert.rejects(staged.submit(scope,third.id,registry,context));closedAt.set(third.id,Date.now());await sleep(settleMs);
  assert.equal(await staged.verifyAndReconcile(scope,third.id,verify),'not_applied');
  proxy.state.mode='lose-response';await assert.rejects(staged.submit(scope,third.id,registry,context),/timed out/);proxy.state.mode='pass';
  assert.equal(await staged.verifyAndReconcile(scope,third.id,verify),'applied');
  const orders=await listOrders();assert.equal(orders.length,3);assert.equal(new Set(orders).size,3);
  assert.equal(attempts.filter(key=>key===third.idempotencyKey).length,2,'two attempts, one order');
 }finally{staged?.close();await proxy?.close();await docker(['rm','-f',name]).catch(()=>{});}
});
