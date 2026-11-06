import {CapabilityRegistry,SqliteOfflineQueue} from '../../dist/index.js';
const [path]=process.argv.slice(2),scope={tenantId:'t',applicationId:'a'},actor={tenantId:'t',principalId:'p',origin:'service'};
process.on('message',()=>{});
const queue=new SqliteOfflineQueue(path,{enabled:true,maxAttempts:2,retryDelayMs:100}),registry=new CapabilityRegistry(()=>{});
registry.register({operationId:'update',method:'POST',path:'/update'},{authorize:()=>true,validate:()=>true,execute:async input=>{process.send({type:'executing',key:input.idempotencyKey});await new Promise(()=>{});}});
queue.enqueue(scope,'p','update','logical',{value:1});
await queue.processOne(scope,actor,registry,()=> 'retry',10);
