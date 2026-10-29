import {DatabaseSync} from 'node:sqlite';
import type {CapabilityAuditEvent} from './capabilities.js';

export type StoredCapabilityAuditEvent=CapabilityAuditEvent & {sequence:number;recordedAt:number};
const text=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=256&&!/[\x00-\x1f\x7f]/.test(value);
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const outcomes=new Set(['attempt','not_found','denied','invalid','succeeded','failed']);

/** Local durable sink; host code must authorize all access to the database and reads. */
export class SqliteCapabilityAudit {
 private readonly db:DatabaseSync;private readonly clock:()=>number;
 constructor(path:string,options:{clock?:()=>number}={}){
  if(typeof path!=='string'||!path||!options||(options.clock!==undefined&&typeof options.clock!=='function'))throw Error('Invalid capability audit configuration');
  this.clock=options.clock??Date.now;this.db=new DatabaseSync(path);
  try{this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS capability_audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, recorded_at INTEGER NOT NULL, operation_id TEXT NOT NULL, tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, outcome TEXT NOT NULL); CREATE INDEX IF NOT EXISTS capability_audit_tenant_sequence ON capability_audit(tenant_id,sequence);');}catch(error){this.db.close();throw error;}
 }
 /** Compatible with CapabilityRegistry's required audit sink. */
 record=(event:CapabilityAuditEvent):void=>{
  if(!event||!text(event.operationId)||!text(event.tenantId)||!text(event.principalId)||!outcomes.has(event.outcome))throw Error('Invalid capability audit event');
  const time=this.clock();if(!integer(time))throw Error('Invalid clock');
  this.db.prepare('INSERT INTO capability_audit(recorded_at,operation_id,tenant_id,principal_id,outcome) VALUES (?,?,?,?,?)').run(time,event.operationId,event.tenantId,event.principalId,event.outcome);
 };
 /** Read only a host-authorized tenant, with stable sequence pagination. */
 list(tenantId:string,options:{after?:number;limit?:number}={}):StoredCapabilityAuditEvent[]{
  if(!text(tenantId)||!options||!integer(options.after??0)||!integer(options.limit??100)||(options.limit??100)<1||(options.limit??100)>1000)throw Error('Invalid capability audit query');
  const rows=this.db.prepare('SELECT sequence,recorded_at,operation_id,tenant_id,principal_id,outcome FROM capability_audit WHERE tenant_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(tenantId,options.after??0,options.limit??100);
  return rows.map(row=>({sequence:Number(row.sequence),recordedAt:Number(row.recorded_at),operationId:String(row.operation_id),tenantId:String(row.tenant_id),principalId:String(row.principal_id),outcome:row.outcome as CapabilityAuditEvent['outcome']}));
 }
 close():void{this.db.close();}
}
