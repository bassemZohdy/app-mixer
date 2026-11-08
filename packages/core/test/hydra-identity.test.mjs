// JWT authentication against a second real OpenID Connect provider: Ory Hydra in Docker (opt-in). The Keycloak test in
// packages/agent covers one provider; this one checks what a different provider does with the same authenticator.
//
// Finding (2026-11-08, Hydra v2.3.0): Hydra's JWT access tokens carry `typ: JWT`, but the authenticator requires the
// RFC 9068 `typ: at+jwt` header, so it refuses every Hydra token. With that single check removed in a scratch build, the
// whole scenario below passed (audience, tamper checks, introspection, provider-side revocation and key rotation), so it
// is the only incompatibility. The authenticator is deliberately strict, because `typ` keeps a JWT that was issued for
// another purpose (an ID token, say) from being accepted as an access token; relaxing it is an owner decision.
// This test records the incompatibility and everything else a Hydra deployment would depend on.
// Not production identity: the provider and clients are local test fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createJwtCapabilityAuthenticator} from '../dist/index.js';
import {waitFor} from '../../../scripts/wait-for.mjs';

const IMAGE='oryd/hydra:v2.3.0@sha256:b94007e19a1f7f78157e7f4ea340da8a55b5f104a0f1198755c256f38ef32b4b',enabled=process.env.APP_MIXER_TEST_HYDRA==='docker';
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:300000}).trim();
const freePort=async()=>{const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const {port}=probe.address();await new Promise(resolve=>probe.close(resolve));return port;};
const part=(token,index)=>JSON.parse(Buffer.from(token.split('.')[index],'base64url'));
const audience='app-mixer-data-plane';

test('Ory Hydra issues JWT access tokens the authenticator refuses only for their typ header',{skip:!enabled&&'set APP_MIXER_TEST_HYDRA=docker to run against Ory Hydra',timeout:240000},async t=>{
  const name='app-mixer-hydra-'+randomUUID().slice(0,8),publicPort=await freePort(),adminPort=await freePort();
  // The issuer name is https because the authenticator requires it; the test reaches Hydra over loopback HTTP.
  const issuer='https://hydra.test.invalid',base=`http://127.0.0.1:${publicPort}`,admin=`http://127.0.0.1:${adminPort}`;
  docker('run','-d','--rm','--name',name,'-p',`127.0.0.1:${publicPort}:4444`,'-p',`127.0.0.1:${adminPort}:4445`,'-e','DSN=memory','-e','URLS_SELF_ISSUER='+issuer,'-e','URLS_LOGIN=http://127.0.0.1:1/login','-e','URLS_CONSENT=http://127.0.0.1:1/consent','-e','SECRETS_SYSTEM=local-test-only-secret-at-least-32-chars','-e','STRATEGIES_ACCESS_TOKEN=jwt',IMAGE,'serve','all','--dev');
  try{
    await waitFor(async()=>(await fetch(base+'/health/ready')).ok,{timeoutMs:60000,intervalMs:500,message:'Hydra to become ready'});
    const secret=id=>id+'-secret-local-test-only',basic=id=>'Basic '+Buffer.from(`${id}:${secret(id)}`).toString('base64');
    const created=await fetch(admin+'/admin/clients',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_id:'svc-a',client_secret:secret('svc-a'),grant_types:['client_credentials'],scope:'read write',audience:[audience],token_endpoint_auth_method:'client_secret_basic'})});
    assert.equal(created.status,201,await created.text());
    const issue=async()=>{const result=await fetch(base+'/oauth2/token',{method:'POST',headers:{authorization:basic('svc-a'),'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',scope:'read',audience})});const body=await result.json();assert.equal(result.status,200,JSON.stringify(body));return body.access_token;};
    const jwks=async()=>(await (await fetch(base+'/.well-known/jwks.json')).json()).keys.filter(k=>k.use==='sig'&&k.kty==='RSA');

    // What Hydra puts in the token: every claim the authenticator requires, a key id and RS256, but typ JWT.
    const token=await issue(),head=part(token,0),body=part(token,1);
    assert.equal(head.alg,'RS256');assert.ok(head.kid);assert.equal(head.typ,'JWT','Hydra does not mark access tokens as at+jwt');
    for(const claim of ['iss','sub','aud','exp','iat','jti','client_id'])assert.ok(body[claim]!==undefined,`the token carries ${claim}`);
    assert.equal(body.iss,issuer);assert.ok(body.aud.includes(audience));assert.equal(body.client_id,'svc-a');
    t.diagnostic(`Hydra access token header ${JSON.stringify(head)}, claims ${Object.keys(body).join(',')}`);

    // The authenticator refuses it, and only because of the header: the keys, issuer, audience and claims are accepted
    // by the same configuration for a token that has the right type (see the Keycloak test).
    const authenticator=createJwtCapabilityAuthenticator({issuer,audience,jwks:{keys:await jwks()},maxTokenAgeSeconds:600,resolveActor:c=>({tenantId:'tenant-1',principalId:'service:'+c.client_id})});
    assert.equal(await authenticator({rawHeaders:['Authorization','Bearer '+token]}),undefined,'typ JWT is not accepted as an access token');

    // Introspection and revocation work at the provider, so a host that accepts these tokens could check them.
    const introspect=async value=>(await (await fetch(admin+'/admin/oauth2/introspect',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:value})})).json());
    let status=await introspect(token);assert.equal(status.active,true);assert.equal(status.client_id,'svc-a');assert.equal(status.sub,body.sub);
    const revoked=await fetch(base+'/oauth2/revoke',{method:'POST',headers:{authorization:basic('svc-a'),'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token})});
    assert.equal(revoked.status,200);status=await introspect(token);assert.equal(status.active,false,'a revoked token is inactive at the provider');

    // Key rotation: deleting the signing key set makes Hydra create a new key, and the old one leaves the published keys.
    const before=(await jwks()).map(k=>k.kid);
    const deleted=await fetch(admin+'/admin/keys/hydra.jwt.access-token',{method:'DELETE'});assert.ok([204,404].includes(deleted.status),'key set deleted: '+deleted.status);
    const rotated=await issue(),after=(await jwks()).map(k=>k.kid);
    assert.notEqual(part(rotated,0).kid,head.kid);assert.ok(after.includes(part(rotated,0).kid));assert.ok(!after.includes(head.kid),'the removed key is no longer published');
    t.diagnostic(`keys before ${before.join(',')}; after ${after.join(',')}`);
  }finally{try{docker('rm','-fv',name);}catch{}}
});
