import {isSpanContextValid,type SpanContext} from '@opentelemetry/api';
import type {DatabaseSync} from 'node:sqlite';
import type {AgentRunScope} from './durable-runs.js';

/** Version-00 W3C traceparent only; tracestate and baggage are deliberately excluded. */
export function parseAgentTraceParent(value:unknown):SpanContext|undefined{
 if(typeof value!=='string'||!/^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/.test(value))return undefined;
 const parts=value.split('-'),result={traceId:parts[1],spanId:parts[2],traceFlags:parseInt(parts[3],16),isRemote:true};return isSpanContextValid(result)?result:undefined;
}
export function ensureAgentTraceSchema(db:DatabaseSync):void{db.exec(`
 CREATE TABLE IF NOT EXISTS agent_run_trace_context (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,trace_parent TEXT NOT NULL,PRIMARY KEY(tenant_id,agent_id,run_id));
 CREATE TRIGGER IF NOT EXISTS agent_trace_no_replace BEFORE INSERT ON agent_run_trace_context WHEN EXISTS(SELECT 1 FROM agent_run_trace_context WHERE tenant_id=NEW.tenant_id AND agent_id=NEW.agent_id AND run_id=NEW.run_id) BEGIN SELECT RAISE(ABORT,'Agent trace context is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS agent_trace_no_update BEFORE UPDATE ON agent_run_trace_context BEGIN SELECT RAISE(ABORT,'Agent trace context is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS agent_trace_no_delete BEFORE DELETE ON agent_run_trace_context BEGIN SELECT RAISE(ABORT,'Agent trace context is immutable'); END;
`);}
export function insertAgentTraceParent(db:DatabaseSync,scope:AgentRunScope,runId:string,parent:string|undefined):void{if(parent!==undefined){if(!parseAgentTraceParent(parent))throw Error('Invalid agent trace context');db.prepare('INSERT INTO agent_run_trace_context VALUES (?,?,?,?)').run(scope.tenantId,scope.agentId,runId,parent);}}
