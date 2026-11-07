// Characterizes what restoring an OLDER PostgreSQL backup silently undoes (P3-03, P3-04 "rollback protection"). The stores keep no
// anchor outside their own database, so a restored database looks internally consistent. This test records the current behaviour so
// that the operator guidance in docs/kubernetes-data-plane.md stays true: when any of these assertions starts to fail, a store gained
// rollback detection and the guidance should be updated. Opt-in: APP_MIXER_TEST_POSTGRES_RESTORE=docker (one PostgreSQL container).
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {PostgresJwtRevocations,PostgresPublicationReleaseRegistry,PostgresExtensionApprovals,PostgresCapabilityAudit} from '../dist/index.js';

const run=promisify(execFile),enabled=process.env.APP_MIXER_TEST_POSTGRES_RESTORE==='docker',image='pgvector/pgvector:0.8.7-pg16',password='restore-test-only';
const docker=(...args)=>run('docker',args,{maxBuffer:10**7}).then(result=>result.stdout.trim());
const issuer='https://identity.example.test/',claims=jti=>({iss:issuer,jti}),release={tenantId:'tenant',applicationId:'app',environment:'prod'},digestOf=version=>String(version).padStart(64,'0');
const admin={tenantId:'tenant',principalId:'admin'},approvalScope={tenantId:'tenant',applicationId:'demo'},reference={id:'example.report',version:'1.0.0',scope:'application'},operation={extensionId:'example.report',kind:'tool',name:'lookup'};
async function waitFor(description,check,attempts=120){for(let i=0;i<attempts;i++){try{const value=await check();if(value)return value;}catch{}await delay(500);}throw Error(`Timed out waiting for ${description}`);}

test('restoring an older backup silently undoes revocations, release floors, approval revocations and audit sequences',{skip:!enabled&&'set APP_MIXER_TEST_POSTGRES_RESTORE=docker to run',timeout:240000},async t=>{
 const name='am-restore-'+randomUUID().slice(0,8);let pool;
 const psql=(sql,database='postgres')=>docker('exec','-u','postgres',name,'psql','-U','postgres','-d',database,'-Atc',sql);
 try{
  await docker('run','-d','--name',name,'-e','POSTGRES_PASSWORD='+password,'-p','127.0.0.1::5432',image);
  await waitFor('PostgreSQL',()=>docker('exec',name,'pg_isready','-h','127.0.0.1','-U','postgres'));
  await psql('CREATE DATABASE app');
  const port=Number((await docker('port',name,'5432/tcp')).split('\n')[0].split(':').pop());
  const connect=()=>new pg.Pool({host:'127.0.0.1',port,user:'postgres',password,database:'app',max:2});
  pool=connect();let now=1700000000000;
  const query=(sql,args)=>pool.query(sql,args);
  const revocations=new PostgresJwtRevocations({issuer,clock:()=>now,query}),releases=new PostgresPublicationReleaseRegistry({query}),approvals=new PostgresExtensionApprovals({query,clock:()=>now,authorize:()=>true}),audit=new PostgresCapabilityAudit({clock:()=>now,query});
  const event=n=>({invocationId:'invocation-'+n,operationId:'write',tenantId:'tenant',principalId:'user',outcome:'attempt'});
  await Promise.all([revocations.initialize(),releases.initialize(),approvals.initialize(),audit.initialize()]);
  // State A: what the backup captures.
  await revocations.revoke('revoked-in-backup',now+3600000);
  for(const version of [1,2,3,4])await releases.register(release,version,digestOf(version));await releases.advanceFloor(release,3);
  await approvals.decide(admin,approvalScope,reference,operation,{allowed:true,expiresAt:now+3600000,expectedRevision:0});
  for(const n of [1,2,3])await audit.record(event(n));
  await docker('exec','-u','postgres',name,'sh','-c','pg_dump -U postgres -Fc app > /tmp/backup.dump');
  // State B: acknowledged after the backup.
  await revocations.revoke('revoked-after-backup',now+3600000);await releases.advanceFloor(release,4);
  await approvals.decide(admin,approvalScope,reference,operation,{allowed:false,expiresAt:0,expectedRevision:1});
  for(const n of [4,5])await audit.record(event(n));
  assert.equal(await revocations.isTokenActive(claims('revoked-after-backup')),false);assert.equal(await releases.isAllowed(release,3,digestOf(3)),false);
  assert.equal(await approvals.isAllowed(admin,approvalScope,reference,operation),false);assert.deepEqual((await audit.list('tenant')).map(row=>row.sequence),[1,2,3,4,5]);
  // Restore the older backup over the live database, as a recovery from a backup would.
  await pool.end();await psql('DROP DATABASE app WITH (FORCE)');await psql('CREATE DATABASE app');
  await docker('exec','-u','postgres',name,'pg_restore','-U','postgres','-d','app','/tmp/backup.dump');
  pool=connect();
  const outcome={
   revokedAfterBackupActiveAgain:await revocations.isTokenActive(claims('revoked-after-backup')),
   revokedInBackupStillRevoked:!(await revocations.isTokenActive(claims('revoked-in-backup'))),
   releaseBelowOldFloorAllowedAgain:await releases.isAllowed(release,3,digestOf(3)),
   revokedApprovalAllowedAgain:await approvals.isAllowed(admin,approvalScope,reference,operation),
   auditSequences:(await audit.list('tenant')).map(row=>row.sequence)
  };
  t.diagnostic(JSON.stringify(outcome));
  // Current behaviour: none of the stores notices that it went back in time.
  assert.equal(outcome.revokedAfterBackupActiveAgain,true,'a token revoked after the backup is active again');
  assert.equal(outcome.revokedInBackupStillRevoked,true);
  assert.equal(outcome.releaseBelowOldFloorAllowedAgain,true,'the release floor went back to the backup value');
  assert.equal(outcome.revokedApprovalAllowedAgain,true,'an approval revoked after the backup is granted again');
  assert.deepEqual(outcome.auditSequences,[1,2,3],'the audit log lost its last two events');
  await audit.record(event(6));assert.deepEqual((await audit.list('tenant')).map(row=>row.sequence),[1,2,3,4],'sequence 4 is reused for a different event, with no sign of the gap');
 }finally{
  await pool?.end().catch(()=>{});await docker('rm','-f',name).catch(()=>{});
 }
});
