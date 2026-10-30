import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const fixture=fileURLToPath(new URL('../../../deploy/kubernetes/test-support/agent-recovery/notice-pod.mjs',import.meta.url)),tls=new URL('../../core/test/fixtures/capability-tls/',import.meta.url);
async function freePort(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));return port;}
function launch(args,env){const child=spawn(process.execPath,[fixture,...args],{env,stdio:['ignore','pipe','pipe']});child.captured='';child.stderr.on('data',x=>child.captured+=String(x));return child;}
async function exited(child){const [code]=await once(child,'exit');assert.equal(code,0,child.captured);}
async function marker(child,expected){let buffer='';await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(Error('Missing '+expected+': '+child.captured));},15000),onExit=()=>{cleanup();reject(Error('Process exited before '+expected+': '+child.captured));},onData=data=>{buffer+=String(data);if(buffer.includes(expected)){cleanup();resolve();}},cleanup=()=>{clearTimeout(timer);child.off('exit',onExit);child.stdout.off('data',onData);};child.on('exit',onExit);child.stdout.on('data',onData);});}
async function kill(child){if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}}

for(const phase of ['before','after'])test(`pod recovery fixture verifies ${phase} receiver commit`,async()=>{const dir=mkdtempSync(join(tmpdir(),'notice-pod-')),port=await freePort(),env={...process.env,TEST_DATA_DIR:dir,TEST_PORT:String(port),TEST_NOTICE_URL:`https://127.0.0.1:${port}/notice`,TEST_TLS_KEY:fileURLToPath(new URL('server-key.pem',tls)),TEST_TLS_CERT:fileURLToPath(new URL('server-cert.pem',tls)),NODE_EXTRA_CA_CERTS:fileURLToPath(new URL('ca-cert.pem',tls))};let receiver,sender,setup,verify;try{
 setup=launch(['setup',phase],env);await exited(setup);receiver=launch(['receiver',phase,'hold'],env);await marker(receiver,'NOTICE_RECEIVER_READY');verify=launch(['probe',phase],env);await exited(verify);sender=launch(['send',phase],env);await marker(receiver,`NOTICE_${phase.toUpperCase()}_COMMIT`);await kill(sender);await kill(receiver);receiver=launch(['receiver',phase,'verify'],env);await marker(receiver,'NOTICE_RECEIVER_READY');verify=launch(['probe',phase],env);await exited(verify);verify=launch(['verify',phase],env);await exited(verify);
 }finally{await kill(sender);await kill(receiver);await kill(setup);await kill(verify);rmSync(dir,{recursive:true,force:true});}});
