import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,rm,readFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../..',import.meta.url));
const SETTINGS=['PORT','DATA_PLANE_URL','AGENT_URL','AGENT_TOKEN','CAPABILITY_URL','CAPABILITY_TOKEN','CONTROL_TOKEN','APP_MIXER_MANIFEST','APP_MIXER_DATABASE'];

async function freePorts(count){
 const servers=[],ports=[];
 for(let n=0;n<count;n++){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));servers.push(server);ports.push(server.address().port);}
 await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));
 return ports;
}
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};

test('FEAT-037 npm run local starts the stack, serves a published page, answers chat and stops on SIGINT',{timeout:120000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'local-stack-'));
 const [workspace,control,data,agent]=await freePorts(4);
 const env={...process.env};for(const name of SETTINGS)delete env[name];
 const child=spawn(process.execPath,['scripts/local-stack.mjs'],{cwd:root,env:{...env,APP_MIXER_LOCAL_DIR:dir,WORKSPACE_PORT:String(workspace),CONTROL_PORT:String(control),DATA_PORT:String(data),AGENT_PORT:String(agent)},stdio:['ignore','pipe','pipe','ipc']});
 let stdout='',stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
 try{
  const url=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('the stack did not become ready: '+stdout+stderr)),90000);
   child.stdout.on('data',chunk=>{stdout+=chunk;const match=stdout.match(/ready (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
   child.once('exit',code=>reject(Error(`the stack exited ${code}: ${stdout}${stderr}`)));
  });
  assert.equal(url,`http://127.0.0.1:${workspace}`);
  const page=await fetch(url);assert.equal(page.status,200);assert.match(await page.text(),/Workspace/);
  const publication=await (await fetch(`${url}/api/publication`)).json();
  assert.equal(publication.version,1);assert.equal(publication.definition.pages[0].title,'Home');
  assert.equal((await fetch(`http://127.0.0.1:${data}/application`)).status,200);
  assert.equal((await fetch(`http://127.0.0.1:${control}/draft`)).status,401);
  const tokenFile=(await readFile(join(dir,'control-token'),'utf8')).trim();
  assert.equal((await fetch(`http://127.0.0.1:${control}/draft`,{headers:{authorization:`Bearer ${tokenFile}`}})).status,200);
  assert.doesNotMatch(stdout+stderr,new RegExp(tokenFile),'the control token is kept out of the output');
  const reply=await fetch(`${url}/api/chat`,{method:'POST',headers:{'content-type':'application/json',origin:url},body:JSON.stringify({threadId:'t',runId:'r',messages:[{id:'m',role:'user',content:'Hello'}],tools:[],context:[],state:{}})});
  assert.equal(reply.status,200);
  const events=await reply.text();assert.match(events,/Local demonstration agent is available/);assert.match(events,/RUN_FINISHED/);
  const pids=(await readFile(join(dir,'pids.json'),'utf8').then(JSON.parse));
  assert.ok(pids.length>=3,'the stack records its service processes');
  assert.ok(pids.every(alive),'all recorded services are running');
  // On POSIX the test sends SIGINT; Windows cannot deliver it to a child, so it asks through the IPC channel, which runs the same shutdown path.
  const exited=once(child,'exit');
  if(process.platform==='win32')child.send('shutdown');else child.kill('SIGINT');
  const [code]=await exited;
  assert.equal(code,0);
  for(let n=0;n<100&&pids.some(alive);n++)await new Promise(resolve=>setTimeout(resolve,100));
  assert.deepEqual(pids.filter(alive),[],'every service process has stopped');
  await assert.rejects(fetch(url));
 }finally{
  if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}
  await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250});
 }
});

test('FEAT-037 the local service names APP_MIXER_MANIFEST when its default manifest is missing',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'local-service-'));
 try{
  const env={...process.env};for(const name of SETTINGS)delete env[name];
  let failure;
  try{execFileSync(process.execPath,['deploy/local/service.mjs','init'],{cwd:root,env:{...env,APP_MIXER_DATABASE:join(dir,'app.sqlite')},stdio:'pipe'});}catch(error){failure=error;}
  assert.ok(failure,'init fails without a manifest');
  const lines=String(failure.stderr).split(/\r?\n/).filter(line=>line.trim());
  assert.equal(lines.length,1,String(failure.stderr));
  assert.match(lines[0],/APP_MIXER_MANIFEST/);
  await assert.rejects(access(join(dir,'app.sqlite')));
 }finally{await rm(dir,{recursive:true,force:true});}
});
