// A real S3-compatible provider for opt-in tests: SeaweedFS in Docker with SigV4 credentials required, plus a TCP proxy
// that can lose requests or responses. Used by the staged-submission and action-journal provider tests.
import {execFile} from 'node:child_process';
import {createHash,createHmac} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {createServer,connect} from 'node:net';

export const image='chrislusf/seaweedfs:4.50@sha256:c2658820e763294a9e9de7b36c81e59b879e3459148351aee4e31a126ca64860';
const access='appmixer',secret='appmixer-test-secret',region='us-east-1';
const docker=args=>new Promise((resolve,reject)=>execFile('docker',args,{timeout:180000,maxBuffer:4*1024*1024},(error,stdout,stderr)=>error?reject(Object.assign(error,{stderr})):resolve(stdout.trim())));
export const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const freePort=()=>new Promise((resolve,reject)=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>resolve(port));});server.on('error',reject);});

// AWS Signature Version 4, enough for path-style S3 requests.
const sha256=value=>createHash('sha256').update(value).digest('hex'),hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
export const encodeKey=key=>key.split('/').map(part=>encodeURIComponent(part)).join('/');
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
export function s3(port,host,{method,path,query,body,headers,timeoutMs=5000}){
 const signedRequest=signed({method,host,path,query,body,headers});
 return new Promise((resolve,reject)=>{
  const req=httpRequest({host:'127.0.0.1',port,method,path:path+(signedRequest.query?'?'+signedRequest.query:''),headers:signedRequest.headers,agent:false,timeout:timeoutMs},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:text}));});
  req.on('timeout',()=>req.destroy(Object.assign(Error('provider request timed out'),{code:'ETIMEDOUT'})));req.on('error',reject);req.end(body);
 });
}

// A TCP proxy in front of the provider. 'pass' forwards both ways; 'lose-response' forwards the request and lets the
// provider answer, but never returns that answer to the client; 'lose-request' closes the connection before
// forwarding anything.
export async function faultyProxy(upstreamPort){
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

// Starts the provider, requires credentials and creates `bucket`. request(options) talks to it directly;
// through(port, options) sends the same signed request via another port such as a faultyProxy.
export async function startS3Provider(bucket){
 const port=await freePort(),name='app-mixer-s3-'+process.pid+'-'+Date.now(),host='127.0.0.1:'+port;
 await docker(['run','-d','--rm','--name',name,'-p',`127.0.0.1:${port}:8333`,image,'server','-s3','-dir=/data']);
 const close=()=>docker(['rm','-f',name]).catch(()=>{});
 try{
  for(let i=0;;i++){try{const response=await s3(port,host,{method:'GET',path:'/',timeoutMs:2000});if(response.status)break;}catch(error){if(i>90)throw error;}await sleep(1000);}
  await docker(['exec',name,'sh','-c',`echo "s3.configure -access_key=${access} -secret_key=${secret} -user=app -actions=Read,Write,List,Admin -apply" | weed shell`]);
  for(let i=0;;i++){const anonymous=await new Promise((resolve,reject)=>{const req=httpRequest({host:'127.0.0.1',port,method:'PUT',path:'/anonymous-probe',agent:false},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});if(anonymous===403)break;if(i>30)throw Error('provider still accepts anonymous requests');await sleep(1000);}
  const created=await s3(port,host,{method:'PUT',path:'/'+bucket});if(created.status!==200)throw Error('bucket not created: '+created.status);
 }catch(error){await close();throw error;}
 const list=async prefix=>{const response=await s3(port,host,{method:'GET',path:'/'+bucket,query:{'list-type':'2',prefix}});if(response.status!==200)throw Error('list failed: '+response.status);return [...response.body.matchAll(/<Key>([^<]+)<\/Key>/g)].map(match=>match[1]).sort();};
 return {port,host,request:options=>s3(port,host,options),through:(via,options)=>s3(via,host,options),objectPath:key=>`/${bucket}/${encodeKey(key)}`,list,close};
}

// A create-only write. A 412 means the object already exists; its stored body is returned so the caller can check
// that it is the same request rather than a reused key.
export async function putOnce(port,host,path,body,timeoutMs=5000){
 const response=await s3(port,host,{method:'PUT',path,body,headers:{'content-type':'application/json','if-none-match':'*'},timeoutMs});
 if(response.status===200)return {created:true};
 if(response.status===412){const existing=await s3(port,host,{method:'GET',path});if(existing.status===200)return {created:false,body:existing.body};}
 throw Error('Provider rejected the write: '+response.status);
}
