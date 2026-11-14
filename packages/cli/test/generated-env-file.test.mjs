import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createProject} from '../dist/index.js';
const SETTINGS=['PORT','DATA_PLANE_URL','AGENT_URL','AGENT_TOKEN','CAPABILITY_URL','CAPABILITY_TOKEN'];
const token='t'.repeat(32);

// Runs the project's own dev script (node <args>) with the settings removed from the environment.
async function startDev(target){
 const {scripts}=JSON.parse(await readFile(join(target,'package.json'),'utf8'));
 assert.match(scripts.dev,/^node /);
 const clean={...process.env,PORT:'0'};for(const name of SETTINGS)if(name!=='PORT')delete clean[name];
 const child=spawn(process.execPath,scripts.dev.split(' ').slice(1),{cwd:target,env:clean,stdio:['ignore','pipe','pipe']});
 const exited=new Promise(resolve=>child.once('exit',resolve));let stdout='',stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
 const url=await new Promise((resolve,reject)=>{
  child.stdout.on('data',chunk=>{stdout+=chunk;const match=stdout.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});
  child.once('error',reject);child.once('exit',code=>reject(new Error(`exited ${code}: ${stderr}`)));
 });
 return {url,stop:async()=>{child.kill();await exited;}};
}

test('FEAT-031 the dev script loads AGENT_URL and AGENT_TOKEN from .env and starts without one',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'generated-env-'));
 try{
  const target=await createProject('env-app',dir);
  let app=await startDev(target);
  try{assert.equal((await (await fetch(`${app.url}/api/chat/status`)).json()).enabled,false);}finally{await app.stop();}
  await writeFile(join(target,'.env'),`PORT=0\nAGENT_URL=http://127.0.0.1:9/agent\nAGENT_TOKEN=${token}\n`);
  app=await startDev(target);
  try{assert.equal((await (await fetch(`${app.url}/api/chat/status`)).json()).enabled,true);}finally{await app.stop();}
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('FEAT-031 the project ignores .env in git',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'generated-gitignore-'));
 try{
  const target=await createProject('env-app',dir);
  const lines=(await readFile(join(target,'.gitignore'),'utf8')).split(/\r?\n/).map(line=>line.trim());
  assert.ok(lines.includes('.env'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
