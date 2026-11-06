import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentSemanticMemory,evaluateAgentMemoryRetrieval} from '../dist/index.js';

const actor={tenantId:'tenant',principalId:'user'},scope={tenantId:'tenant',agentId:'agent',ownerId:'owner',kind:'semantic'};
const rankings={A:['x','a','b'],B:['a','y','z'],C:[],D:['a','b','c']};
const memory=Object.assign(Object.create(AgentSemanticMemory.prototype),{searchLexical:async(_actor,_scope,query)=>rankings[query].map(id=>({id,score:1}))});
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} !== ${expected}`);

test('retrieval evaluation reports binary-relevance nDCG at the configured limit',async()=>{
 const report=await evaluateAgentMemoryRetrieval({memory,actor,scope,mode:'lexical',limit:3,cases:[
  {id:'A',query:'A',relevantIds:['a','b']},{id:'B',query:'B',relevantIds:['a']},{id:'C',query:'C',relevantIds:['a']},{id:'D',query:'D',relevantIds:['a','b','c','d']}]});
 const byId=Object.fromEntries(report.cases.map(item=>[item.id,item.ndcg]));
 const log3=1/Math.log2(3),log4=1/Math.log2(4);
 near(byId.A,(log3+log4)/(1+log3));      // relevant items at ranks 2 and 3, ideal at ranks 1 and 2
 near(byId.B,1);                         // relevant item first
 near(byId.C,0);                         // nothing retrieved
 near(byId.D,1);                         // ideal list is capped at the limit, so three hits of four is perfect
 near(report.meanNdcg,((log3+log4)/(1+log3)+1+0+1)/4);
 assert.ok(report.cases.every(item=>item.ndcg>=0&&item.ndcg<=1));
});
