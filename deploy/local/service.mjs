import {readFile} from 'node:fs/promises';
import {timingSafeEqual} from 'node:crypto';
import {SqliteApplicationStore,PublishedDefinitionCache,CachedPublishedRepository,createDataPlane,createControlPlane,DataPlaneRequestMetrics,createMetricsServer} from '../../packages/core/dist/index.js';
import {createAGUIServer,LangGraphAGUIAdapter} from '../../packages/agent/dist/index.js';

const role=process.argv[2];
const database=process.env.APP_MIXER_DATABASE||'/data/app.sqlite';
const initial=JSON.parse(await readFile(process.env.APP_MIXER_MANIFEST || new URL('../../demo-app/application.json',import.meta.url),'utf8'));
const port=(name,defaultPort)=>{const value=Number(process.env[name]||defaultPort);if(!Number.isInteger(value)||value<1||value>65535)throw Error(`Invalid ${name}`);return value;};
if(role==='init'){
  const store=new SqliteApplicationStore(database,initial);
  try{if(!store.getPublished())store.publish(store.getDraft().revision);}finally{store.close();}
}else{
  let server,store,metricsServer;
  if(role==='data'){
    const token=process.env.DATA_METRICS_TOKEN;if(token!==undefined&&token!==''&&(token.length<32||token.length>4096||/[\x00-\x1f\x7f]/.test(token)))throw Error('Invalid DATA_METRICS_TOKEN');
    const health=process.env.DATA_HEALTH_ENABLED;if(health!==undefined&&!['true','false'].includes(health))throw Error('Invalid DATA_HEALTH_ENABLED');
    store=new SqliteApplicationStore(database,initial);
    const scope={tenantId:'local',authorizationKey:'local',applicationId:initial.id,schemaVersion:initial.schemaVersion};
    const metrics=token?new DataPlaneRequestMetrics():undefined;
    if(metrics){const expected=Buffer.from(`Bearer ${token}`);metricsServer=createMetricsServer({metrics,timeoutMs:1000,maxPending:16,authorize:req=>{let header;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()==='authorization'){if(header!==undefined)return false;header=req.rawHeaders[i+1];}if(typeof header!=='string'||header.length>8192)return false;const supplied=Buffer.from(header);return supplied.length===expected.length&&timingSafeEqual(supplied,expected);}});}
    server=createDataPlane(new CachedPublishedRepository(store,scope,new PublishedDefinitionCache()),{...(health==='true'?{health:{timeoutMs:1000}}:{}),...(metrics?{observe:metrics.observe}:{})});
    if(metricsServer)metricsServer.listen(port('DATA_METRICS_PORT',3004),'127.0.0.1');
    server.listen(port('DATA_PORT',3002),'127.0.0.1');
  }else if(role==='control'){
    store=new SqliteApplicationStore(database,initial);
    server=createControlPlane(store,process.env.CONTROL_TOKEN);
    server.listen(port('CONTROL_PORT',3001),process.env.CONTROL_BIND||'127.0.0.1');
  }else if(role==='agent'){
    const model={async *stream(){yield 'Local demonstration agent is available.';}};
    server=createAGUIServer(new LangGraphAGUIAdapter(model),process.env.AGENT_TOKEN);
    server.listen(port('AGENT_PORT',3003),'127.0.0.1');
  }else throw Error('Unknown local service');
  server.once('listening',()=>console.log(`${role} ready`));
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{const servers=[server,...(metricsServer?[metricsServer]:[])];Promise.all(servers.map(item=>new Promise(resolve=>item.close(resolve)))).then(()=>{store?.close();process.exit(0);});});
}
