import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApplicationStore,SqliteApplicationStore,createControlPlane,createDataPlane,createRemoteControlConnector,RemoteControlImportUncertainError} from '../dist/index.js';

const definition={id:'demo',schemaVersion:1,revision:0,pages:[{id:'home',route:'/',title:'Home',components:[]}]},token='source-secret-at-least-32-characters-long',request={actor:{tenantId:'t',principalId:'admin'},sourceVersion:1,expectedVersion:0};
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function close(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
function config(sourceOrigin,repository,extra={}){return {sourceOrigin,sourceToken:token,sourceEnvironment:'development',targetEnvironment:'production',applicationId:'demo',repository,allowLoopbackHttp:true,authorize:()=>true,audit:()=>{},...extra};}

test('imports authenticated publications locally and keeps serving during source outage',async()=>{
 const source=new ApplicationStore(definition),target=new ApplicationStore(definition);source.publish(0);const remote=createControlPlane(source,token),local=createDataPlane(target),[url,localUrl]=await Promise.all([listen(remote),listen(local)]),events=[];
 try{const connector=createRemoteControlConnector(config(url,target,{audit:event=>events.push(event.phase)}));const result=await connector.importPublication(request);assert.equal(result.version,1);assert.equal(target.getPublicationProvenance(1).sourceEnvironment,'development');assert.deepEqual(events,['attempt','source_verified','import_authorized','completed']);assert.equal((await (await fetch(localUrl+'/application')).json()).version,1);await close(remote);await assert.rejects(connector.importPublication({...request,expectedVersion:1}),/export failed/);assert.equal((await (await fetch(localUrl+'/application')).json()).version,1);}finally{if(remote.listening)await close(remote);await close(local);}
});

test('checks authorization before fetching and before local import',async()=>{
 const source=new ApplicationStore(definition),target=new ApplicationStore(definition);source.publish(0);const remote=createControlPlane(source,token),url=await listen(remote),stages=[],events=[];
 try{const connector=createRemoteControlConnector(config(url,target,{authorize:(stage,details)=>{stages.push(stage);assert.equal(details.actor.principalId,'admin');assert.equal(JSON.stringify(details).includes(token),false);return stage==='export';},audit:event=>events.push(event.phase)}));await assert.rejects(connector.importPublication(request),/authorization denied/);assert.deepEqual(stages,['export','import']);assert.deepEqual(events,['attempt','source_verified','denied']);assert.equal(target.getPublished(),undefined);}finally{await close(remote);}
});

test('SQLite publication and provenance survive restart without the remote source',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'remote-control-')),path=join(dir,'app.sqlite'),source=new ApplicationStore(definition);source.publish(0);const remote=createControlPlane(source,token),url=await listen(remote);let target=new SqliteApplicationStore(path,definition);
 try{await createRemoteControlConnector(config(url,target)).importPublication(request);await close(remote);target.close();target=new SqliteApplicationStore(path,definition);assert.equal(target.getPublished().version,1);assert.equal(target.getPublicationProvenance(1).sourceEnvironment,'development');}finally{target.close();if(remote.listening)await close(remote);rmSync(dir,{recursive:true,force:true});}
});

test('bad source, redirects, configuration and uncertain local writes fail closed',async()=>{
 const target=new ApplicationStore(definition),redirect=createServer((_req,res)=>{res.writeHead(302,{location:'http://example.com'});res.end();}),url=await listen(redirect);
 try{assert.throws(()=>createRemoteControlConnector(config('http://example.com',target)),/configuration/);assert.throws(()=>createRemoteControlConnector(config('https://user@example.com',target)),/configuration/);await assert.rejects(createRemoteControlConnector(config(url,target)).importPublication(request),/export failed/);assert.equal(target.getPublished(),undefined);}finally{await close(redirect);}
 const source=new ApplicationStore(definition);source.publish(0);const remote=createControlPlane(source,token),base=await listen(remote),events=[];
 try{const connector=createRemoteControlConnector(config(base,target,{audit:event=>{events.push(event.phase);if(event.phase==='completed')throw Error('audit unavailable');}}));await assert.rejects(connector.importPublication(request),RemoteControlImportUncertainError);assert.equal(target.getPublished().version,1);assert.equal(events.at(-1),'uncertain');}finally{await close(remote);}
});
