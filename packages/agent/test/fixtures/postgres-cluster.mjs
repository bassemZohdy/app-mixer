// A PostgreSQL primary with a synchronous standby in Docker, behind a TCP proxy that a test repoints at the promoted standby, like a
// platform repointing a service address after a failover. Used by the opt-in failover tests (APP_MIXER_TEST_POSTGRES_FAILOVER=docker).
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer,connect} from 'node:net';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const run=promisify(execFile),image='pgvector/pgvector:0.8.7-pg16',password='failover-test-only';
const docker=(...args)=>run('docker',args,{maxBuffer:10**7}).then(result=>result.stdout.trim());
export async function waitFor(description,check,attempts=120){let last;for(let i=0;i<attempts;i++){try{const value=await check();if(value)return value;}catch(error){last=error;}await delay(500);}throw Error(`Timed out waiting for ${description}`+(last?`: ${String(last.stderr||last.message).trim().slice(0,400)}`:''));}

/** Forwards TCP connections to a target that can be changed or removed. */
async function proxy(){
 let target;const sockets=new Set();
 const server=createServer(client=>{
  if(!target){client.destroy();return;}
  const upstream=connect(target.port,'127.0.0.1');sockets.add(client).add(upstream);
  for(const [a,b] of [[client,upstream],[upstream,client]]){a.pipe(b);a.on('error',()=>b.destroy());a.on('close',()=>{b.destroy();sockets.delete(a);});}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {port:server.address().port,point:next=>{target=next;for(const socket of sockets)socket.destroy();sockets.clear();},close:()=>{for(const socket of sockets)socket.destroy();return new Promise(resolve=>server.close(()=>resolve()));}};
}

export async function startCluster(){
 const id=randomUUID().slice(0,8),network='am-cluster-'+id,primary='am-cprimary-'+id,standby='am-cstandby-'+id,front=await proxy();
 const published=async name=>{const port=Number((await docker('port',name,'5432/tcp')).split(String.fromCharCode(10))[0].split(':').pop());if(!Number.isInteger(port)||port<1||port>65535)throw Error(`Could not read the published port of ${name}`);return port;};
 const cleanup=async()=>{await front.close();await docker('rm','-fv',primary,standby).catch(()=>{});await docker('network','rm',network).catch(()=>{});};
 try{
  await docker('network','create',network);
  await docker('run','-d','--name',primary,'--network',network,'-e','POSTGRES_PASSWORD='+password,'-p','127.0.0.1::5432',image,'postgres','-c','wal_level=replica','-c','max_wal_senders=5','-c','synchronous_standby_names=*','-c','synchronous_commit=remote_apply','-c','max_connections=200');
  // The image first runs a temporary server on the socket only; a TCP check passes only for the real server.
  await waitFor('the primary',()=>docker('exec',primary,'pg_isready','-h','127.0.0.1','-U','postgres'));
  await docker('exec',primary,'bash','-c','echo "host replication all all scram-sha-256" >> "$PGDATA/pg_hba.conf"');await docker('exec','-u','postgres',primary,'psql','-U','postgres','-c','SELECT pg_reload_conf()');
  await docker('run','-d','--name',standby,'--network',network,'-e','PGPASSWORD='+password,'-p','127.0.0.1::5432','--entrypoint','bash',image,'-c',`chown postgres "$PGDATA" && chmod 700 "$PGDATA" && gosu postgres pg_basebackup -h ${primary} -U postgres -D "$PGDATA" -R -X stream && exec gosu postgres postgres -c hot_standby=on -c max_connections=200`);
  await waitFor('a synchronous standby',async()=>(await docker('exec','-u','postgres',primary,'psql','-U','postgres','-Atc','SELECT sync_state FROM pg_stat_replication')).trim()==='sync');
  const primaryPort=await published(primary),standbyPort=await published(standby);front.point({port:primaryPort});
  return {
   url:`postgresql://postgres:${password}@127.0.0.1:${front.port}/postgres`,
   killPrimary:()=>docker('kill',primary),
   promote:async()=>{await docker('exec','-u','postgres',standby,'psql','-U','postgres','-c','SELECT pg_promote()');await waitFor('promotion',async()=>(await docker('exec','-u','postgres',standby,'psql','-U','postgres','-Atc','SELECT pg_is_in_recovery()')).trim()==='f');front.point({port:standbyPort});},
   cleanup
  };
 }catch(error){await cleanup();throw error;}
}
