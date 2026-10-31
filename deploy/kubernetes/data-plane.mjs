import {readFile,stat} from 'node:fs/promises';
import {createPublicKey} from 'node:crypto';
import pg from 'pg';
import {createDataPlane,createDataPlaneHttps,createTlsCredentialReloader,createJwtCapabilityAuthenticator,DataPlaneRequestMetrics,createMetricsServer,PostgresJwtRevocations,PostgresPublicationReleaseRegistry,definitionSha256,validate,verifyPublicationRelease} from '../../packages/core/dist/index.js';

// The host owns release approval and the trust roots mounted separately from the publication.
const path=process.env.APP_MIXER_PUBLICATION_PATH;
if(!path)throw Error('APP_MIXER_PUBLICATION_PATH is required');
if((await stat(path)).size>1024*1024+4096)throw Error('Publication too large');
const input=JSON.parse(await readFile(path,'utf8')),mode=process.env.APP_MIXER_PUBLICATION_MODE??'signed';let publication,releaseEnvironment;
if(mode==='signed'){
 const keyPath=process.env.APP_MIXER_RELEASE_KEYS_PATH,environment=process.env.APP_MIXER_RELEASE_ENV,applicationId=process.env.APP_MIXER_APPLICATION_ID;
 if(!keyPath||!environment||!applicationId||(await stat(keyPath)).size>32768)throw Error('Invalid release verification configuration');
 const raw=JSON.parse(await readFile(keyPath,'utf8'));if(!Array.isArray(raw)||raw.length<1||raw.length>20)throw Error('Invalid release verification configuration');
 const keys=raw.map(entry=>{if(!entry||typeof entry!=='object'||Array.isArray(entry)||Object.keys(entry).sort().join(',')!=='keyId,publicKey'||typeof entry.publicKey!=='string'||entry.publicKey.length>4096||!/^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----\s*$/.test(entry.publicKey))throw Error('Invalid release verification configuration');return {keyId:entry.keyId,publicKey:createPublicKey(entry.publicKey)};});
 publication=verifyPublicationRelease(input,environment,applicationId,keys);releaseEnvironment=environment;
}else if(mode==='unsigned'){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='definition,version'||!Number.isSafeInteger(input.version)||input.version<1)throw Error('Invalid publication');validate(input.definition);publication=input;
}else throw Error('Invalid publication mode');
const snapshot=structuredClone(publication),repository={getPublished(version){return version===undefined||version===snapshot.version?structuredClone(snapshot):undefined;}};
const portText=process.env.DATA_PORT??'3002',delayText=process.env.DATA_DRAIN_DELAY_MS??'5000';
if(!/^[1-9][0-9]{0,4}$/.test(portText)||Number(portText)>65535||!/^(0|[1-9][0-9]{0,4})$/.test(delayText)||Number(delayText)>30000)throw Error('Invalid Data Plane configuration');
const metricsPort=process.env.APP_MIXER_METRICS_PORT;
if(metricsPort!==undefined&&(!/^[1-9][0-9]{0,4}$/.test(metricsPort)||Number(metricsPort)>65535||metricsPort===portText))throw Error('Invalid metrics configuration');
const accessMode=process.env.APP_MIXER_ACCESS_MODE??'jwt';let authenticate,authenticateMetrics,revocationPool,releaseTenant;
if(metricsPort!==undefined&&accessMode!=='jwt')throw Error('Metrics require JWT access');
if(accessMode==='jwt'){
 const keyPath=process.env.APP_MIXER_JWKS_PATH,issuer=process.env.APP_MIXER_JWT_ISSUER,audience=process.env.APP_MIXER_JWT_AUDIENCE,tenant=process.env.APP_MIXER_TENANT_ID,requiredScope=process.env.APP_MIXER_JWT_SCOPE??'app-mixer:publication.read',maxAge=process.env.APP_MIXER_JWT_MAX_AGE_SECONDS??'600';
 if(!keyPath||!issuer||!audience||!tenant||tenant.length>256||/[\x00-\x20\x7f]/.test(tenant)||!requiredScope||requiredScope.length>256||/[\x00-\x20\x7f]/.test(requiredScope)||!/^[1-9][0-9]{0,4}$/.test(maxAge)||Number(maxAge)>86400||(await stat(keyPath)).size>131072)throw Error('Invalid publication access configuration');
 if(metricsPort!==undefined&&requiredScope==='app-mixer:metrics.read')throw Error('Invalid metrics configuration');
 releaseTenant=tenant;const jwks=JSON.parse(await readFile(keyPath,'utf8')),revocationMode=process.env.APP_MIXER_REVOCATION_MODE??'postgres';let isTokenActive;
 if(revocationMode==='postgres'){
  const dsnPath=process.env.APP_MIXER_REVOCATION_DSN_PATH,caPath=process.env.APP_MIXER_REVOCATION_CA_PATH;
  if(!dsnPath||!caPath||(await stat(dsnPath)).size>8192||(await stat(caPath)).size>65536)throw Error('Invalid revocation configuration');
  const dsn=(await readFile(dsnPath,'utf8')).trim(),ca=await readFile(caPath,'utf8');let url;try{url=new URL(dsn);}catch{throw Error('Invalid revocation configuration');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.username||!url.password||!/^\/[^/]+$/.test(url.pathname)||url.search||url.hash||!ca.trim())throw Error('Invalid revocation configuration');
  revocationPool=new pg.Pool({connectionString:dsn,ssl:{ca,rejectUnauthorized:true},max:5,connectionTimeoutMillis:2000,idleTimeoutMillis:10000,query_timeout:2000,statement_timeout:1500,application_name:'app-mixer-data-plane'});
  revocationPool.on('error',()=>{});
  const revocations=new PostgresJwtRevocations({issuer,query:(sql,args)=>revocationPool.query(sql,args)});isTokenActive=claims=>revocations.isTokenActive(claims);
 }else if(revocationMode!=='disabled')throw Error('Invalid revocation configuration');
 const authenticator=scope=>createJwtCapabilityAuthenticator({issuer,audience,jwks,maxTokenAgeSeconds:Number(maxAge),...(isTokenActive?{isTokenActive}:{}),resolveActor:claims=>claims.tenant_id===tenant&&typeof claims.scope==='string'&&claims.scope.split(' ').includes(scope)?{tenantId:tenant,principalId:claims.sub}:undefined});
 authenticate=authenticator(requiredScope);if(metricsPort!==undefined)authenticateMetrics=authenticator('app-mixer:metrics.read');
}else if(accessMode!=='public')throw Error('Invalid publication access configuration');
const floorMode=process.env.APP_MIXER_RELEASE_FLOOR_MODE??'disabled';let releaseAllowed;
if(floorMode==='postgres'){
 if(!revocationPool||!authenticate||!releaseEnvironment||!releaseTenant||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseTenant))throw Error('Invalid publication release floor configuration');
 const registry=new PostgresPublicationReleaseRegistry({query:(sql,args)=>revocationPool.query(sql,args)}),releaseScope={tenantId:releaseTenant,applicationId:snapshot.definition.id,environment:releaseEnvironment},digest=definitionSha256(snapshot.definition);
 releaseAllowed=()=>registry.isAllowed(releaseScope,snapshot.version,digest);
}else if(floorMode!=='disabled')throw Error('Invalid publication release floor configuration');
const metrics=metricsPort===undefined?undefined:new DataPlaneRequestMetrics();
const transport=process.env.APP_MIXER_TRANSPORT??'tls',planeOptions={health:{timeoutMs:2500,...(revocationPool?{check:async()=>{try{await revocationPool.query('SELECT 1 FROM app_mixer_jwt_revocations LIMIT 1');return releaseAllowed?await releaseAllowed():true;}catch{return false;}}}:{})},...(authenticate?{authorizePublication:async req=>!!await authenticate(req)&&(!releaseAllowed||await releaseAllowed())}:{}),...(metrics?{observe:metrics.observe}:{})};let server;
let tlsReloader;
if(transport==='tls'){
 const certPath=process.env.APP_MIXER_TLS_CERT_PATH,keyPath=process.env.APP_MIXER_TLS_KEY_PATH,caPath=process.env.APP_MIXER_TLS_CLIENT_CA_PATH;
 if(!certPath||!keyPath||(caPath!==undefined&&!caPath)||(await stat(certPath)).size>65536||(await stat(keyPath)).size>65536||(caPath&&(await stat(caPath)).size>65536))throw Error('Invalid data plane transport configuration');
 const reloadText=process.env.APP_MIXER_TLS_RELOAD_MS;if(reloadText!==undefined&&(!/^[1-9][0-9]{3,7}$/.test(reloadText)||Number(reloadText)>86400000))throw Error('Invalid data plane transport configuration');
 const loadTls=async()=>({cert:await readFile(certPath),key:await readFile(keyPath),...(caPath?{clientCa:await readFile(caPath)}:{})});
 server=createDataPlaneHttps(repository,await loadTls(),planeOptions);
 // Optional: pick up renewed Secret files (for example from cert-manager) without a restart; invalid files keep the current credentials.
 if(reloadText!==undefined){tlsReloader=createTlsCredentialReloader(server,{load:loadTls,intervalMs:Number(reloadText),clientCa:!!caPath,onReload:info=>console.log(`TLS credentials active: ${info.subject.replaceAll('\n',', ')} until ${new Date(info.validTo).toISOString()}`),onError:error=>console.error(`TLS reload rejected: ${error.message}`)});}
}else if(transport==='http')server=createDataPlane(repository,planeOptions);else throw Error('Invalid data plane transport configuration');server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
const metricsServer=metrics?createMetricsServer({metrics,authorize:async req=>!!await authenticateMetrics(req),timeoutMs:2500,maxPending:20}):undefined;
metricsServer?.listen(Number(metricsPort),'127.0.0.1');
server.on('close',()=>{tlsReloader?.stop();metricsServer?.close();authenticate?.close();authenticateMetrics?.close();if(revocationPool)void revocationPool.end().catch(()=>{});});
server.listen(Number(portText),'0.0.0.0');
server.once('listening',()=>console.log('Data Plane ready'));
let stopping=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(stopping)return;stopping=true;server.beginDrain();setTimeout(()=>server.close(),Number(delayText));});
