import {SqliteAgentDelegations} from '../../dist/index.js';

const store=new SqliteAgentDelegations(process.env.APP_MIXER_TEST_DB,{scope:{tenantId:'tenant',agentId:'agent'},runId:'run',authorize:()=>true,clock:()=>10});
try { await store.renew({tenantId:'tenant',principalId:'admin'},'grant',1,'v2',100); }
finally { store.close(); }
