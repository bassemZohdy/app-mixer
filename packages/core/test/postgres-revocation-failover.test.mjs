// Failover drill for the shared token revocation store (P3-01, P3-04). A PostgreSQL primary streams to a synchronous standby
// (synchronous_commit=remote_apply). A TCP proxy stands in for the virtual address or service a platform repoints at a new
// primary. The drill revokes a token, kills the primary, checks that revocation lookups deny rather than allow while the
// database is down, promotes the standby, repoints the proxy and checks that the acknowledged revocation survived, that other
// tokens work again and that new revocations are accepted. Opt-in: APP_MIXER_TEST_POSTGRES_FAILOVER=docker (two PostgreSQL containers).
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer,connect} from 'node:net';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {PostgresJwtRevocations} from '../dist/index.js';

const run=promisify(execFile),enabled=process.env.APP_MIXER_TEST_POSTGRES_FAILOVER==='docker',image='pgvector/pgvector:0.8.7-pg16',password='failover-test-only';
const docker=(...args)=>run('docker',args,{maxBuffer:10**7}).then(result=>result.stdout.trim());
const issuer='https://identity.example.test/',claims=jti=>({iss:issuer,jti});

/** Forwards TCP connections to a target that can be changed, like a service address repointed after a failover. */
async function proxy(){
 let target,sockets=new Set();
 const server=createServer(client=>{
  if(!target){client.destroy();return;}
  const upstream=connect(target.port,'127.0.0.1');sockets.add(client).add(upstream);
  for(const [a,b] of [[client,upstream],[upstream,client]]){a.pipe(b);a.on('error',()=>b.destroy());a.on('close',()=>{b.destroy();sockets.delete(a);});}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {port:server.address().port,point:next=>{target=next;for(const socket of sockets)socket.destroy();sockets.clear();},close:()=>{for(const socket of sockets)socket.destroy();server.close();}};
}
async function waitFor(description,check,attempts=120){for(let i=0;i<attempts;i++){try{const value=await check();if(value)return value;}catch{}await delay(500);}throw Error(`Timed out waiting for ${description}`);}
const published=async name=>Number((await docker('port',name,'5432/tcp')).split('\n')[0].split(':').pop());

test('an acknowledged revocation survives a primary failover and lookups deny while the database is down',{skip:!enabled&&'set APP_MIXER_TEST_POSTGRES_FAILOVER=docker to run',timeout:300000},async t=>{
 const id=randomUUID().slice(0,8),network='am-failover-'+id,primary='am-primary-'+id,standby='am-standby-'+id,front=await proxy();let pool;
 try{
  await docker('network','create',network);
  await docker('run','-d','--name',primary,'--network',network,'-e','POSTGRES_PASSWORD='+password,'-p','127.0.0.1::5432',image,'postgres','-c','wal_level=replica','-c','max_wal_senders=5','-c','synchronous_standby_names=*','-c','synchronous_commit=remote_apply');
  await waitFor('the primary',()=>docker('exec',primary,'pg_isready','-U','postgres'));
  await docker('exec',primary,'bash','-c','echo "host replication all all scram-sha-256" >> "$PGDATA/pg_hba.conf"');await docker('exec','-u','postgres',primary,'psql','-U','postgres','-c','SELECT pg_reload_conf()');
  await docker('run','-d','--name',standby,'--network',network,'-e','PGPASSWORD='+password,'-p','127.0.0.1::5432','--entrypoint','bash',image,'-c',`chown postgres "$PGDATA" && chmod 700 "$PGDATA" && gosu postgres pg_basebackup -h ${primary} -U postgres -D "$PGDATA" -R -X stream && exec gosu postgres postgres -c hot_standby=on`);
  await waitFor('a synchronous standby',async()=>(await docker('exec','-u','postgres',primary,'psql','-U','postgres','-Atc',"SELECT sync_state FROM pg_stat_replication")).trim()==='sync');
  const primaryPort=await published(primary),standbyPort=await published(standby);
  front.point({port:primaryPort});
  pool=new pg.Pool({host:'127.0.0.1',port:front.port,user:'postgres',password,database:'postgres',max:2,connectionTimeoutMillis:2000,idleTimeoutMillis:1000});
  pool.on('error',()=>{});
  let now=1700000000000;const store=new PostgresJwtRevocations({issuer,clock:()=>now,query:(sql,args)=>pool.query(sql,args)});
  await store.initialize();
  await store.revoke('revoked-before-failover',now+3600000);
  assert.equal(await store.isTokenActive(claims('revoked-before-failover')),false);assert.equal(await store.isTokenActive(claims('other-token')),true);

  await docker('kill',primary);const killed=performance.now();
  const outage=await store.isTokenActive(claims('other-token')).then(value=>({value}),error=>({error}));
  assert.ok(outage.error||outage.value===false,'a lookup during the outage must not allow the token');
  assert.ok(outage.error,'the outage surfaces as a database error, which the authenticator turns into a denial');
  await assert.rejects(store.revoke('during-outage',now+3600000));

  await docker('exec','-u','postgres',standby,'psql','-U','postgres','-c','SELECT pg_promote()');
  await waitFor('promotion',async()=>(await docker('exec','-u','postgres',standby,'psql','-U','postgres','-Atc','SELECT pg_is_in_recovery()')).trim()==='f');
  front.point({port:standbyPort});
  const recovered=await waitFor('lookups to recover',async()=>{try{return await store.isTokenActive(claims('other-token'));}catch{return false;}},40);
  t.diagnostic(`revocation lookups allowed an unrevoked token again ${((performance.now()-killed)/1000).toFixed(1)} s after the primary was killed`);
  assert.equal(recovered,true);
  assert.equal(await store.isTokenActive(claims('revoked-before-failover')),false,'an acknowledged revocation is not lost by the failover');
  await store.revoke('revoked-after-failover',now+3600000);assert.equal(await store.isTokenActive(claims('revoked-after-failover')),false);
  assert.equal(await store.isTokenActive(claims('other-token')),true);
 }finally{
  await pool?.end().catch(()=>{});front.close();
  await docker('rm','-f',primary,standby).catch(()=>{});await docker('network','rm',network).catch(()=>{});
 }
});
