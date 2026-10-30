import {createAgentNoticeHttpsTransport} from '../../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},send=createAgentNoticeHttpsTransport({scope,destinations:[{id:'local',url:process.env.TEST_NOTICE_URL,bearerToken:'a'.repeat(32)}],timeoutMs:5000});
await send({noticeId:1,...scope,runId:'run',kind:'approval_requested',subjectId:'action',subjectRevision:0},'local','123e4567-e89b-42d3-a456-426614174000');
