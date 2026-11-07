// End-to-end identity against a real OpenID Connect provider (Keycloak in Docker, opt-in). A user delegates to the
// agent's service principal and the delegation's expiry, its revocation and revocation at the provider each stop
// the next delegated call mid-run. A reviewer approves through the review API, the approval notice is delivered
// over HTTPS with a provider-issued client credential, and the approval audit is exported. Not production identity:
// the provider, users and clients are local test fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {get} from 'node:https';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const IMAGE='quay.io/keycloak/keycloak:26.6.4',enabled=process.env.APP_MIXER_TEST_KEYCLOAK==='docker';
const tls=fileURLToPath(new URL('../../core/test/fixtures/capability-tls/',import.meta.url)),realm=fileURLToPath(new URL('./fixtures/keycloak-realm.json',import.meta.url)),ca=readFileSync(tls+'ca-cert.pem');
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const probe=url=>new Promise(resolve=>{const request=get(url,{ca,timeout:2000},response=>{response.resume();resolve(response.statusCode);});request.on('error',()=>resolve(0));request.on('timeout',()=>{request.destroy();resolve(0);});});

test('a real OIDC provider authenticates delegation, approval and notice delivery, and its revocations stop a run',{skip:!enabled&&'set APP_MIXER_TEST_KEYCLOAK=docker to run against Keycloak',timeout:300000},async t=>{
 const name='app-mixer-keycloak-'+randomUUID().slice(0,8);
 docker('run','-d','--rm','--name',name,'-p','127.0.0.1::8443','-e','KC_BOOTSTRAP_ADMIN_USERNAME=admin','-e','KC_BOOTSTRAP_ADMIN_PASSWORD=admin-local-test-only','-v',`${realm}:/opt/keycloak/data/import/realm.json:ro`,'-v',`${tls}:/tls:ro`,IMAGE,'start-dev','--import-realm','--https-certificate-file=/tls/server-cert.pem','--https-certificate-key-file=/tls/server-key.pem','--http-enabled=false');
 try{
  const port=docker('port',name,'8443/tcp').split('\n')[0].split(':').at(-1),base=`https://127.0.0.1:${port}`,issuer=base+'/realms/app-mixer';
  let ready=false;for(let i=0;i<120&&!ready;i++){ready=await probe(issuer+'/.well-known/openid-configuration')===200;if(!ready)await new Promise(resolve=>setTimeout(resolve,1000));}
  assert.ok(ready,'Keycloak did not become ready:\n'+docker('logs','--tail','40',name));
  const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/keycloak-identity-scenario.mjs',import.meta.url))],{env:{...process.env,NODE_EXTRA_CA_CERTS:tls+'ca-cert.pem',KEYCLOAK_ISSUER:issuer,KEYCLOAK_ADMIN_BASE:base},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const [code]=await once(child,'exit');assert.equal(code,0,stderr);
  const summary=JSON.parse(stdout.trim().split('\n').at(-1));
  for(const [key,value] of Object.entries(summary))t.diagnostic(`${key}: ${JSON.stringify(value)}`);
  assert.equal(summary.normal.type,'RUN_FINISHED');assert.equal(summary.expiry.type,'RUN_ERROR');assert.equal(summary.revocation.type,'RUN_ERROR');assert.equal(summary.identityProviderRevocation.type,'RUN_ERROR');assert.equal(summary.effects,5);
  assert.deepEqual(summary.approvalAudit.map(e=>e.event),['requested','approved']);assert.ok(summary.introspections.inactive>=3);
 }finally{try{docker('rm','-fv',name);}catch{}}
});
