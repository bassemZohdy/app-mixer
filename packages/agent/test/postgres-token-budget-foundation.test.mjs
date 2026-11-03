import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresAgentTriggerFoundation} from '../dist/postgres-trigger-foundation.js';
import {PostgresAgentRunLifecycleFoundation} from '../dist/postgres-run-lifecycle-foundation.js';
import {PostgresAgentTokenBudgetFoundation} from '../dist/postgres-token-budget-foundation.js';
const transaction=pool=>async operation=>{const client=await pool.connect();try{await client.query('BEGIN');const value=await operation((sql,args)=>client.query(sql,args));await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};

test('shared token and cost budget stays pinned and fails closed on provider overuse',{skip:!process.env.APP_MIXER_TEST_POSTGRES_URL,timeout:60000},async()=>{
 const schema='shared_budget_'+randomUUID().replaceAll('-',''),url=process.env.APP_MIXER_TEST_POSTGRES_URL,admin=new pg.Pool({connectionString:url}),pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`}),scope={tenantId:'tenant',agentId:'agent'},config={query:(sql,args)=>pool.query(sql,args),transaction:transaction(pool)};
 try{
  await admin.query(`CREATE SCHEMA "${schema}"`);const triggers=new PostgresAgentTriggerFoundation(config),runs=new PostgresAgentRunLifecycleFoundation(config);await triggers.initialize();await runs.initialize();const {runId}=await triggers.enqueue(scope,{sourceId:'manual',principalId:'person',eventId:'budget',eventType:'manual',payload:{}},{definitionVersion:1,maxAttempts:3,deadline:Date.now()+60000,maxPending:10}),claim=await runs.claim(scope,runId,1,'worker',30000,10),bound={...config,scope,runId,leaseToken:claim.leaseToken},budget=new PostgresAgentTokenBudgetFoundation({...bound,maxTokens:100,cost:{currency:'USD',maxMicros:1000}});await budget.initialize();
  const binding={tenantId:'tenant',budgetId:'monthly',currency:'USD',maxMicros:5000};await budget.reserve('call',40,400,binding);await assert.rejects(budget.reserve('different',1,1),/binding conflict/);const wrong=new PostgresAgentTokenBudgetFoundation({...bound,maxTokens:99,cost:{currency:'USD',maxMicros:1000}});await assert.rejects(wrong.summary(),/budget conflict/);const wrongCost=new PostgresAgentTokenBudgetFoundation({...bound,maxTokens:100,cost:{currency:'EUR',maxMicros:1000}});await assert.rejects(wrongCost.costSummary(),/budget conflict/);
  await budget.settle('call',41,401);assert.deepEqual(await budget.getCost('call'),{callId:'call',currency:'USD',reserved:400,used:401,status:'settled'});await assert.rejects(budget.reserve('next',1,1,binding),/Token provider limit violated/);
  const foreign=new PostgresAgentTokenBudgetFoundation({...bound,scope:{...scope,tenantId:'other'},maxTokens:100,cost:{currency:'USD',maxMicros:1000}});assert.deepEqual(await foreign.summary(),{limit:100,committed:0,reserved:0});await assert.rejects(foreign.reserve('call',1,1,binding),/shared cost binding/);
 }finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}
});
