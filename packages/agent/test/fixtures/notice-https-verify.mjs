import {createAgentNoticeHttpsVerifier} from '../../dist/index.js';
const scope={tenantId:'tenant',agentId:'agent'},verify=createAgentNoticeHttpsVerifier({scope,destinations:[{id:'local',url:process.env.TEST_NOTICE_URL,bearerToken:'a'.repeat(32)}],timeoutMs:5000});
const message={noticeId:1,...scope,runId:'run',kind:'approval_requested',subjectId:'action',subjectRevision:0};
if(await verify(message,'local','123e4567-e89b-42d3-a456-426614174000')!==true)throw Error('Receipt missing');
if(await verify(message,'local','123e4567-e89b-42d3-a456-426614174001')!==false)throw Error('Unexpected receipt');
