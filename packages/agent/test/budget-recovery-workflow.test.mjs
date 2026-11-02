import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

test('authenticated budget recovery workflow verifies HTTPS usage and preserves tenant isolation',{timeout:90000},async()=>{
 const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/budget-recovery-workflow.mjs',import.meta.url))],{env:{...process.env,NODE_EXTRA_CA_CERTS:fileURLToPath(new URL('../../core/test/fixtures/capability-tls/ca-cert.pem',import.meta.url))},stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',chunk=>stderr+=String(chunk));try{const [code,signal]=await once(child,'exit');assert.equal(code,0,stderr||String(signal));}finally{if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill('SIGKILL');await stopped;}}
});
