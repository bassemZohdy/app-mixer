// Child process for keycloak-identity.test.mjs. It runs with NODE_EXTRA_CA_CERTS set to the test CA, so Keycloak and
// the notice receiver are reached over certificate-validated HTTPS. Every identity comes from a Keycloak token
// verified through OIDC discovery and JWKS, and is checked again by token introspection, so revocation at the
// identity provider takes effect on the next request. Prints a JSON summary; any failed assertion exits non-zero.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {createServer as createHttpsServer} from 'node:https';
import {AIMessage} from '@langchain/core/messages';
import {SqliteAgentRuns,SqliteAgentDefinitions,SqliteAgentDelegations,SqliteAgentApprovals,SqliteAgentNotices,SqliteAgentNoticeDelivery,SqliteAgentNoticeReceiver,createAgentNoticeReceiverServer,createAgentNoticeHttpsTransport,createAgentNoticeHttpsVerifier,createAgentApprovalServer,createConfiguredAgentRun} from '../../dist/index.js';
import {CapabilityRegistry,createJwtCapabilityAuthenticator,createOidcJwtJwksManager} from '../../../core/dist/index.js';

const issuer=process.env.KEYCLOAK_ISSUER,admin=process.env.KEYCLOAK_ADMIN_BASE,tls=new URL('../../../core/test/fixtures/capability-tls/',import.meta.url);
const discovery=await (await fetch(issuer+'/.well-known/openid-configuration')).json();
assert.equal(discovery.issuer,issuer);
const form=body=>({method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});
async function token(body){const response=await fetch(discovery.token_endpoint,form(body)),json=await response.json();if(!response.ok)throw Error('token: '+json.error);return json.access_token;}
const password=(username,secret)=>token({grant_type:'password',client_id:'app-mixer-cli',username,password:secret});
const service=(clientId,secret)=>token({grant_type:'client_credentials',client_id:clientId,client_secret:secret});
const claims=value=>JSON.parse(Buffer.from(value.split('.')[1],'base64url'));

// Host identity policy: the tenant is the user's single Keycloak group; users and service clients get distinct principals.
const resolveActor=c=>Array.isArray(c.groups)&&c.groups.length===1?{tenantId:c.groups[0],principalId:c.client_id==='app-mixer-cli'?'user:'+c.sub:'service:'+c.client_id}:undefined;
const presented=new Map(),introspections={active:0,inactive:0};
async function introspect(c){const raw=presented.get(c.jti);if(!raw)return false;const response=await fetch(discovery.introspection_endpoint,{...form({token:raw}),headers:{'content-type':'application/x-www-form-urlencoded',authorization:'Basic '+Buffer.from('agent-gateway:agent-gateway-local-test-only').toString('base64')}});const result=response.ok?await response.json():{};const active=result.active===true&&result.sub===c.sub&&result.jti===c.jti;introspections[active?'active':'inactive']++;return active;}
async function identity(audience){
 const jwks=await (await fetch(discovery.jwks_uri)).json(),authenticator=createJwtCapabilityAuthenticator({issuer,audience,jwks:{keys:jwks.keys.filter(k=>k.use==='sig'&&k.kty==='RSA')},maxTokenAgeSeconds:600,resolveActor,isTokenActive:introspect});
 const manager=await createOidcJwtJwksManager({authenticator,issuer,pollMs:60000,maxStaleMs:300000,timeoutMs:5000,onError:error=>{throw error;}});await manager.refresh();
 return async req=>{const index=req.rawHeaders.findIndex((value,i)=>i%2===0&&/^authorization$/i.test(value)),header=index<0?'':req.rawHeaders[index+1];const raw=/^Bearer (.+)$/.exec(header)?.[1];let jti;try{jti=claims(raw).jti;}catch{}if(jti)presented.set(jti,raw);try{return await manager.authenticate(req);}finally{if(jti)presented.delete(jti);}};
}
const bearer=value=>({rawHeaders:['Authorization','Bearer '+value]});
async function adminRequest(path,options={}){const access=await (await fetch(admin+'/realms/master/protocol/openid-connect/token',form({grant_type:'password',client_id:'admin-cli',username:'admin',password:'admin-local-test-only'}))).json();const response=await fetch(admin+'/admin/realms/app-mixer'+path,{...options,headers:{authorization:'Bearer '+access.access_token,'content-type':'application/json'}});if(!response.ok)throw Error(`admin ${path}: ${response.status}`);return response.status===204?undefined:response.json();}

const agentAuth=await identity('https://agents.app-mixer.test/'),noticeAuth=await identity('https://notices.app-mixer.test/');
const dir=mkdtempSync(join(tmpdir(),'app-mixer-keycloak-')),path=join(dir,'agent.sqlite'),scope={tenantId:'tenant',agentId:'agent'},summary={};
const runs=new SqliteAgentRuns(path),definitions=new SqliteAgentDefinitions(':memory:'),closers=[()=>runs.close(),()=>definitions.close()];
try{
 const aliceToken=await password('alice','alice-local-test-only'),malloryToken=await password('mallory','mallory-local-test-only'),reviewerToken=await password('reviewer','reviewer-local-test-only'),serviceToken=await service('agent-service','agent-service-local-test-only');
 const alice=await agentAuth(bearer(aliceToken)),mallory=await agentAuth(bearer(malloryToken)),reviewer=await agentAuth(bearer(reviewerToken)),worker=await agentAuth(bearer(serviceToken));
 assert.equal(alice.tenantId,'tenant');assert.match(alice.principalId,/^user:[0-9a-f-]{36}$/);assert.equal(mallory.tenantId,'other');assert.deepEqual(worker,{tenantId:'tenant',principalId:'service:agent-service'});
 assert.equal(await agentAuth(bearer(await service('agent-notifier','agent-notifier-local-test-only'))),undefined,'a token for another audience is refused');
 assert.equal(await agentAuth(bearer(aliceToken.slice(0,-4)+'AAAA')),undefined,'a tampered token is refused');
 summary.principals={alice:alice.principalId,reviewer:reviewer.principalId,worker:worker.principalId,malloryTenant:mallory.tenantId};

 // P3-05: a user delegates to the agent's service principal; expiry and revocation take effect during a run.
 definitions.save('tenant',{manifestVersion:1,tenantId:'tenant',agentId:'agent',name:'Agent',owner:{kind:'organization',id:'org'},administrators:[reviewer.principalId],servicePrincipalId:worker.principalId,model:{provider:'local',model:'test'},allowedCapabilities:['lookup'],lifecycle:{enabled:true,maxAttempts:3,runTimeoutMs:600000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:10}},0);
 runs.create(scope,'run',{definitionVersion:1,maxAttempts:3,deadline:Date.now()+600000},Date.now());
 let skew=0;const clock=()=>Date.now()+skew;
 const delegations=new SqliteAgentDelegations(path,{scope,runId:'run',clock,authorize:(actor,access,grant)=>access==='verify'?actor.principalId===worker.principalId:actor.principalId===grant.principalId});closers.push(()=>delegations.close());
 await assert.rejects(delegations.issue(mallory,{...scope,runId:'run',grantId:'grant',principalId:mallory.principalId,permissionVersion:'v1',expiresAt:clock()+120000}),/actor/,'another tenant cannot delegate');
 await assert.rejects(delegations.issue(reviewer,{...scope,runId:'run',grantId:'grant',principalId:alice.principalId,permissionVersion:'v1',expiresAt:clock()+120000}),/denied/,'nobody else can delegate alice');
 let current=(await delegations.issue(await agentAuth(bearer(aliceToken)),{...scope,runId:'run',grantId:'grant',principalId:alice.principalId,permissionVersion:'v1',expiresAt:clock()+120000})).grant;
 let effects=0;const registry=new CapabilityRegistry(()=>{});registry.register({operationId:'lookup',method:'GET',path:'/lookup'},{authorize:actor=>actor.principalId===alice.principalId,validate:()=>true,execute:()=>{effects++;return true;}});
 // The service principal re-authenticates (signature, expiry and introspection) on every delegated call.
 const authorizeDelegation=async(_identity,grant)=>{const actor=await agentAuth(bearer(serviceToken));return !!actor&&actor.principalId===worker.principalId&&await delegations.verify(actor,grant);};
 const run=async(grant,between)=>{const agent=await createConfiguredAgentRun({definitions,tenantId:'tenant',agentId:'agent',expectedVersion:1,bindings:[{operationId:'lookup',toolName:'lookup',description:'Look up'}],registry,authorizeRun:()=>true,authorizeCapability:()=>true,delegation:{grant,clock,authorize:authorizeDelegation},createModel:()=>{let turn=0;return {async invoke(){turn++;if(turn===2)await between();return turn<=2?new AIMessage({content:'',tool_calls:[{id:'call-'+turn,name:'lookup',args:{}}]}):new AIMessage('Done');}};}});const events=[];for await(const event of agent.run({threadId:'thread',runId:'run',messages:[{role:'user',content:'Look up twice'}]}))events.push(event);const last=events.at(-1);return {type:last.type,code:last.code??null};};
 summary.normal=await run(current,async()=>{});assert.equal(summary.normal.type,'RUN_FINISHED');assert.equal(effects,2);
 summary.expiry=await run(current,async()=>{skew=121000;});assert.deepEqual(summary.expiry,{type:'RUN_ERROR',code:'AGENT_DELEGATION_EXPIRED'});assert.equal(effects,3,'the call after expiry is not made');
 current=(await delegations.renew(await agentAuth(bearer(aliceToken)),'grant',current.revision,'v2',clock()+120000)).grant;
 summary.revocation=await run(current,async()=>{const actor=await agentAuth(bearer(aliceToken));await delegations.revoke(actor,'grant',current.revision);});assert.equal(summary.revocation.type,'RUN_ERROR');assert.equal(effects,4,'the call after revocation is not made');
 summary.delegationHistory=(await delegations.history(alice,'grant')).map(e=>({event:e.event,actor:e.actorId===alice.principalId?'alice':e.actorId}));
 assert.deepEqual(summary.delegationHistory.map(e=>e.event),['issued','renewed','revoked']);assert.ok(summary.delegationHistory.every(e=>e.actor==='alice'));

 // Revocation at the identity provider: disabling the service client stops the next delegated call mid-run.
 runs.create(scope,'run-2',{definitionVersion:1,maxAttempts:3,deadline:Date.now()+600000},Date.now());
 const second=new SqliteAgentDelegations(path,{scope,runId:'run-2',clock,authorize:(actor,access,grant)=>access==='verify'?actor.principalId===worker.principalId:actor.principalId===grant.principalId});closers.push(()=>second.close());
 const grant2=(await second.issue(await agentAuth(bearer(aliceToken)),{...scope,runId:'run-2',grantId:'grant',principalId:alice.principalId,permissionVersion:'v1',expiresAt:clock()+120000})).grant;
 const [client]=await adminRequest('/clients?clientId=agent-service');
 const agent2=await createConfiguredAgentRun({definitions,tenantId:'tenant',agentId:'agent',expectedVersion:1,bindings:[{operationId:'lookup',toolName:'lookup',description:'Look up'}],registry,authorizeRun:()=>true,authorizeCapability:()=>true,delegation:{grant:grant2,clock,authorize:async(_identity,grant)=>{const actor=await agentAuth(bearer(serviceToken));return !!actor&&await second.verify(actor,grant);}},createModel:()=>{let turn=0;return {async invoke(){turn++;if(turn===2)await adminRequest('/clients/'+client.id,{method:'PUT',body:JSON.stringify({...client,enabled:false})});return turn<=2?new AIMessage({content:'',tool_calls:[{id:'call-'+turn,name:'lookup',args:{}}]}):new AIMessage('Done');}};}});
 const events=[];for await(const event of agent2.run({threadId:'thread',runId:'run-2',messages:[{role:'user',content:'Look up twice'}]}))events.push(event);
 summary.identityProviderRevocation={type:events.at(-1).type};assert.equal(events.at(-1).type,'RUN_ERROR');assert.equal(effects,5,'only the call before the client was disabled is made');
 assert.equal(await agentAuth(bearer(serviceToken)),undefined,'the disabled client\'s existing token no longer authenticates');
 await adminRequest('/clients/'+client.id,{method:'PUT',body:JSON.stringify({...client,enabled:true})});
 // Logging alice out at the identity provider stops her existing token too.
 const [user]=await adminRequest('/users?username=alice&exact=true');await adminRequest(`/users/${user.id}/logout`,{method:'POST'});
 assert.equal(await agentAuth(bearer(aliceToken)),undefined,'a logged-out user\'s token no longer authenticates');
 summary.effects=effects;

 // P3-06: the service principal requests approval, a notice is delivered over HTTPS with a Keycloak client
 // credential, and the reviewer approves through the review API with their own Keycloak token.
 let approvalRun=runs.create(scope,'approval-run',{definitionVersion:1,maxAttempts:3,deadline:Date.now()+600000},Date.now());approvalRun=runs.claim(scope,'approval-run',approvalRun.revision,'worker',300000,Date.now());
 const approvals=new SqliteAgentApprovals(path,{scope,runId:'approval-run',authorize:(actor,access)=>actor.principalId===worker.principalId?access==='request':actor.principalId===reviewer.principalId});closers.push(()=>approvals.close());
 const notices=new SqliteAgentNotices(path,{scope,authorize:actor=>actor.principalId===reviewer.principalId});closers.push(()=>notices.close());
 const freshWorker=await agentAuth(bearer(await service('agent-service','agent-service-local-test-only')));
 await approvals.request(freshWorker,approvalRun.leaseToken,'pay-invoice','pay',{invoice:'INV-42',amount:120},Date.now()+300000);
 const [notice]=(await notices.list(reviewer)).items;assert.equal(notice.kind,'approval_requested');

 const receiver=new SqliteAgentNoticeReceiver(join(dir,'receiver.sqlite'),{scope,maxPending:10,authorize:(actor,access)=>actor.principalId==='service:agent-notifier'?['receive','verify'].includes(access):actor.principalId===reviewer.principalId&&['list','read','acknowledge'].includes(access)});closers.push(()=>receiver.close());
 const plain=createAgentNoticeReceiverServer({receiver,authenticate:noticeAuth}),secure=createHttpsServer({key:readFileSync(new URL('server-key.pem',tls)),cert:readFileSync(new URL('server-cert.pem',tls))},(req,res)=>plain.emit('request',req,res));
 secure.listen(0,'127.0.0.1');await once(secure,'listening');closers.push(()=>new Promise(resolve=>secure.close(resolve)));
 const destination={id:'reviewers',url:`https://127.0.0.1:${secure.address().port}/notice`,getBearerToken:()=>service('agent-notifier','agent-notifier-local-test-only')};
 const outbox=new SqliteAgentNoticeDelivery(path,{scope,authorize:actor=>actor.principalId===reviewer.principalId,authorizeList:()=>true});closers.push(()=>outbox.close());
 const delivery=await outbox.queue(reviewer,notice.id,'reviewers');
 assert.equal((await fetch(destination.url,{method:'POST',headers:{authorization:'Bearer '+serviceToken,'content-type':'application/json','idempotency-key':delivery.idempotencyKey},body:'{}'})).status,401,'the agent service token is not a notifier credential');
 await outbox.dispatch(reviewer,delivery.id,createAgentNoticeHttpsTransport({scope,destinations:[destination]}));
 assert.equal((await outbox.get(reviewer,delivery.id)).status,'delivered');
 const notifierToken=await service('agent-notifier','agent-notifier-local-test-only'),notifier=await noticeAuth(bearer(notifierToken));
 const received=(await receiver.list(reviewer)).items;assert.equal(received.length,1);assert.equal(received[0].senderId,notifier.principalId);assert.equal(received[0].message.subjectId,'pay-invoice');
 assert.equal(JSON.stringify(received[0].message).includes('INV-42'),false,'the notice carries no approval input');
 assert.equal(await createAgentNoticeHttpsVerifier({scope,destinations:[destination]})(received[0].message,'reviewers',delivery.idempotencyKey),true);
 await receiver.acknowledge(reviewer,received[0].id);

 const review=createAgentApprovalServer({authenticate:agentAuth,resolve:()=>approvals});review.listen(0,'127.0.0.1');await once(review,'listening');closers.push(()=>new Promise(resolve=>review.close(resolve)));
 const base=`http://127.0.0.1:${review.address().port}`,api=base+'/api/agents/agent/runs/approval-run/approvals',decide=(value,body={decision:'approved'})=>fetch(api+'/pay-invoice/decision',{method:'POST',headers:{authorization:'Bearer '+value,origin:base,'content-type':'application/json'},body:JSON.stringify(body)});
 const reviewerNow=await password('reviewer','reviewer-local-test-only'),aliceNow=await password('alice','alice-local-test-only'),malloryNow=await password('mallory','mallory-local-test-only');
 summary.reviewStatuses={anonymous:(await fetch(api)).status,otherTenant:(await fetch(api,{headers:{authorization:'Bearer '+malloryNow}})).status,nonReviewerDecision:(await decide(aliceNow)).status,revokedToken:(await decide(aliceToken)).status};
 assert.equal(summary.reviewStatuses.anonymous,401);assert.equal(summary.reviewStatuses.otherTenant,404);assert.equal(summary.reviewStatuses.nonReviewerDecision,403);assert.equal(summary.reviewStatuses.revokedToken,401);
 const list=await (await fetch(api,{headers:{authorization:'Bearer '+reviewerNow}})).json();assert.deepEqual(list.items[0].input,{invoice:'INV-42',amount:120});
 const decided=await decide(reviewerNow);assert.equal(decided.status,200);assert.equal((await decided.json()).decidedBy,reviewer.principalId);
 const audit=await (await fetch(api+'/pay-invoice/history',{headers:{authorization:'Bearer '+reviewerNow}})).json();
 summary.approvalAudit=audit.events.map(e=>({event:e.event,actor:e.actorId===reviewer.principalId?'reviewer':e.actorId===worker.principalId?'worker':e.actorId}));
 assert.deepEqual(summary.approvalAudit,[{event:'requested',actor:'worker'},{event:'approved',actor:'reviewer'}]);
 summary.introspections=introspections;
 process.stdout.write(JSON.stringify(summary)+'\n');
}finally{for(const close of closers.reverse())await close();rmSync(dir,{recursive:true,force:true});}
