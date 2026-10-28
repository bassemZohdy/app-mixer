import {readFile} from 'node:fs/promises';
import {SqliteApplicationStore,PublishedDefinitionCache,CachedPublishedRepository,createDataPlane,createControlPlane} from '../../packages/core/dist/index.js';
import {createAGUIServer,LangGraphAGUIAdapter} from '../../packages/agent/dist/index.js';

const role=process.argv[2];
const database=process.env.APP_MIXER_DATABASE||'/data/app.sqlite';
const initial=JSON.parse(await readFile(process.env.APP_MIXER_MANIFEST || new URL('../../demo-app/application.json',import.meta.url),'utf8'));
const port=(name,defaultPort)=>{const value=Number(process.env[name]||defaultPort);if(!Number.isInteger(value)||value<1||value>65535)throw Error(`Invalid ${name}`);return value;};
if(role==='init'){
  const store=new SqliteApplicationStore(database,initial);
  try{if(!store.getPublished())store.publish(store.getDraft().revision);}finally{store.close();}
}else{
  let server,store;
  if(role==='data'){
    store=new SqliteApplicationStore(database,initial);
    const scope={tenantId:'local',authorizationKey:'local',applicationId:initial.id,schemaVersion:initial.schemaVersion};
    server=createDataPlane(new CachedPublishedRepository(store,scope,new PublishedDefinitionCache()));
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
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close(()=>{store?.close();process.exit(0);}));
}
