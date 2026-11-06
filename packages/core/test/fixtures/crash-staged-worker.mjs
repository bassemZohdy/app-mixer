import {CapabilityRegistry,SqliteStagedOperations} from '../../dist/index.js';
const [path]=process.argv.slice(2),scope={tenantId:'tenant',applicationId:'app'},context={tenantId:'tenant',principalId:'user',origin:'ui'};
process.on('message',()=>{});
const staged=new SqliteStagedOperations(path),registry=new CapabilityRegistry(()=>{});
registry.register({operationId:'charge',method:'POST',path:'/charge'},{authorize:()=>true,validate:()=>true,execute:async input=>{process.send({type:'submitting',key:input.idempotencyKey,id:operation.id});await new Promise(()=>{});}});
const operation=staged.stage(scope,'charge',{amount:10});
await staged.submit(scope,operation.id,registry,context);
