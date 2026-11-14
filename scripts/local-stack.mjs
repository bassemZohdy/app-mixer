// Starts the generated demo workspace, a Data Plane, a Control Plane and the demonstration agent on loopback, without Docker.
// State lives in APP_MIXER_LOCAL_DIR (default .local): the generated app, the SQLite database, the Control Plane token and the service process IDs.
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {access,mkdir,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const fail=message=>{console.error('local-stack: '+message);process.exit(1);};
const port=(name,fallback)=>{
 const text=process.env[name]??String(fallback);
 if(!/^\d{1,5}$/.test(text)||Number(text)<1||Number(text)>65535)fail(`${name} must be a port from 1 to 65535`);
 return Number(text);
};
const ports={workspace:port('WORKSPACE_PORT',3000),control:port('CONTROL_PORT',3001),data:port('DATA_PORT',3002),agent:port('AGENT_PORT',3003)};
if(new Set(Object.values(ports)).size!==4)fail('the four ports must differ');
const localDir=resolve(process.env.APP_MIXER_LOCAL_DIR||join(root,'.local'));
const cli=join(root,'packages/cli/dist/index.js'),service=join(root,'deploy/local/service.mjs');
try{await access(cli);}catch{fail('build first: npm run build');}

await mkdir(localDir,{recursive:true});
const appDir=join(localDir,'demo-app');
try{await access(join(appDir,'application.json'));}catch{const {createProject}=await import(pathToFileURL(cli).href);await createProject('demo-app',localDir);}
const controlToken=randomBytes(32).toString('hex'),agentToken=randomBytes(32).toString('hex');
await writeFile(join(localDir,'control-token'),controlToken+'\n',{mode:0o600});

const serviceEnv={...process.env,APP_MIXER_MANIFEST:join(appDir,'application.json'),APP_MIXER_DATABASE:join(localDir,'app.sqlite'),CONTROL_PORT:String(ports.control),DATA_PORT:String(ports.data),AGENT_PORT:String(ports.agent),CONTROL_TOKEN:controlToken,AGENT_TOKEN:agentToken};
const children=[];let stopping=false;

function launch(label,file,args,cwd,env,ready){
 const child=spawn(process.execPath,[file,...args],{cwd,env,stdio:['ignore','pipe','pipe']});
 const exited=new Promise(resolveExit=>child.once('exit',(code,signal)=>resolveExit({code,signal})));
 let resolveReady;const started=new Promise((resolveStart,reject)=>{resolveReady=resolveStart;exited.then(result=>reject(Error(`${label} exited (${result.code??result.signal}) before it was ready`)));});
 const relay=(stream,sink)=>{let pending='';stream.on('data',chunk=>{pending+=chunk;let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end).replace(/\r$/,'');pending=pending.slice(end+1);sink(`[${label}] ${line}`);if(ready&&ready.test(line))resolveReady();}});};
 relay(child.stdout,line=>console.log(line));relay(child.stderr,line=>console.error(line));
 if(!ready)resolveReady();
 const entry={label,child,exited};children.push(entry);
 if(ready)exited.then(result=>{if(!stopping){console.error(`local-stack: ${label} stopped unexpectedly (${result.code??result.signal})`);stop(1);}});
 return {child,exited,started};
}

async function stop(code){
 if(stopping)return;stopping=true;
 for(const {child} of children.slice().reverse())if(child.exitCode===null&&child.signalCode===null)child.kill('SIGINT');
 const force=setTimeout(()=>{for(const {child} of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},10000);
 await Promise.all(children.map(item=>item.exited));
 clearTimeout(force);process.exit(code);
}
for(const signal of ['SIGINT','SIGTERM','SIGBREAK'])process.on(signal,()=>stop(0));
process.on('message',message=>{if(message==='shutdown')stop(0);});

try{
 const init=launch('init',service,['init'],root,serviceEnv);
 const result=await init.exited;if(result.code!==0)throw Error('the definition store could not be initialised');
 children.splice(children.findIndex(item=>item.label==='init'),1);
 const started=[];
 for(const role of ['data','control','agent'])started.push(launch(role,service,[role],root,serviceEnv,/ready$/).started);
 const web=launch('workspace',join(appDir,'server.mjs'),[],appDir,{...process.env,PORT:String(ports.workspace),DATA_PLANE_URL:`http://127.0.0.1:${ports.data}/application`,AGENT_URL:`http://127.0.0.1:${ports.agent}/agent`,AGENT_TOKEN:agentToken},/^http:\/\/127\.0\.0\.1:\d+$/);
 started.push(web.started);
 await Promise.all(started);
 await writeFile(join(localDir,'pids.json'),JSON.stringify(children.map(item=>item.child.pid)));
 console.log(`Control Plane: http://127.0.0.1:${ports.control} (bearer token in ${join(localDir,'control-token')})`);
 console.log(`ready http://127.0.0.1:${ports.workspace}`);
}catch(error){
 if(!stopping){console.error('local-stack: '+error.message);await stop(1);}
}
