import {DatabaseSync} from 'node:sqlite';
import {writeSync} from 'node:fs';
import {SqliteStagedOperations} from '../../dist/index.js';
const store=new SqliteStagedOperations(process.env.STAGED_TEST_DB),phase=process.env.STAGED_TEST_PHASE,exec=DatabaseSync.prototype.exec;
const barrier=()=>{writeSync(1,phase+'\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT'&&phase==='before-commit')barrier();const result=exec.call(this,sql);if(sql==='COMMIT'&&phase==='after-commit')barrier();return result;};
store.reconcileWithEvidence({tenantId:'tenant',applicationId:'app'},process.env.STAGED_TEST_ID,'applied',{principalId:'operator',reference:'case'});
throw Error('Worker should have been terminated');
