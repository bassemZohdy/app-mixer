import {SqliteAgentNoticeDelivery} from '../../dist/index.js';
const outbox=new SqliteAgentNoticeDelivery(process.env.TEST_DB,{scope:{tenantId:'tenant',agentId:'agent'},clock:()=>10,authorize:()=>true});
setInterval(()=>{},1000);
await outbox.dispatch({tenantId:'tenant',principalId:'reviewer'},Number(process.env.TEST_DELIVERY),async()=>{process.stdout.write('SENDING\n');await new Promise(()=>{});});
