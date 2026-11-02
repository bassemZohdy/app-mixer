import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const fixture=fileURLToPath(new URL('../../../deploy/kubernetes/test-support/agent-recovery/budget-recovery.mjs',import.meta.url));
function launch(args,env){const child=spawn(process.execPath,[fixture,...args],{env,stdio:['ignore','pipe','pipe']});child.errors='';child.stderr.on('data',chunk=>child.errors+=String(chunk));return child;}
async function exited(child){const [code,signal]=await once(child,'exit');assert.equal(code,0,child.errors||String(signal));}
async function marker(child,expected){let buffer='';await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(Error('Missing '+expected+': '+child.errors));},45000),onExit=()=>{cleanup();reject(Error('Process exited before '+expected+': '+child.errors));},onData=data=>{buffer+=String(data);if(buffer.includes(expected)){cleanup();resolve();}},cleanup=()=>{clearTimeout(timer);child.off('exit',onExit);child.stdout.off('data',onData);};child.on('exit',onExit);child.stdout.on('data',onData);});}
async function kill(child){if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}}
for(const phase of ['during','after'])test(`budget pod fixture survives termination ${phase} reconciliation`,{timeout:90000},async()=>{const dir=mkdtempSync(join(tmpdir(),'budget-pod-')),env={...process.env,TEST_DATA_DIR:dir};let setup,worker,verify;try{setup=launch(['setup',phase],env);await exited(setup);worker=launch(['hold',phase],env);await marker(worker,`BUDGET_${phase.toUpperCase()}`);await kill(worker);verify=launch(['verify',phase],env);await exited(verify);}finally{await kill(worker);await kill(setup);await kill(verify);rmSync(dir,{recursive:true,force:true});}});
