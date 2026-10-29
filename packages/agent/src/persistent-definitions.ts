import {z} from 'zod';
import {DatabaseSync} from 'node:sqlite';

const identifier=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/);
const unique=(items:string[])=>new Set(items).size===items.length;
const manifestSchema=z.object({
 manifestVersion:z.literal(1),
 tenantId:identifier,
 agentId:identifier,
 name:z.string().trim().min(1).max(160),
 owner:z.object({kind:z.enum(['organization','team','application','service','user']),id:identifier}).strict(),
 administrators:z.array(identifier).min(1).max(128).refine(unique),
 userAssociation:identifier.optional(),
 servicePrincipalId:identifier,
 model:z.object({provider:identifier,model:identifier,credentialRef:identifier.optional()}).strict(),
 allowedCapabilities:z.array(identifier).max(256).refine(unique),
 lifecycle:z.object({enabled:z.boolean(),maxAttempts:z.number().int().min(1).max(100),runTimeoutMs:z.number().int().min(1000).max(86400000)}).strict(),
 quotas:z.object({maxConcurrentRuns:z.number().int().min(1).max(100),maxTokensPerRun:z.number().int().min(1).max(10000000),maxRunsPerDay:z.number().int().min(1).max(1000000)}).strict()
}).strict();
export type PersistentAgentManifest=z.infer<typeof manifestSchema>;
export type AgentDefinitionVersion={version:number;manifest:PersistentAgentManifest};
export function validateAgentManifest(value:unknown):PersistentAgentManifest {
 const result=manifestSchema.safeParse(value);if(!result.success)throw Error('Invalid agent manifest');
 const manifest=result.data;if(Buffer.byteLength(JSON.stringify(manifest),'utf8')>65536)throw Error('Invalid agent manifest');return structuredClone(manifest);
}
function key(value:unknown):asserts value is string {if(!identifier.safeParse(value).success)throw Error('Invalid agent scope');}

/** Local, versioned configuration repository. The caller must authorize every operation. */
export class SqliteAgentDefinitions {
 private readonly db:DatabaseSync;
 constructor(path:string){
  this.db=new DatabaseSync(path);
  try{this.db.exec(`PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS agent_definitions (
    tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,version INTEGER NOT NULL,manifest TEXT NOT NULL,
    PRIMARY KEY(tenant_id,agent_id,version)
   );
   CREATE TRIGGER IF NOT EXISTS agent_definitions_no_replace BEFORE INSERT ON agent_definitions
    WHEN EXISTS(SELECT 1 FROM agent_definitions WHERE tenant_id=NEW.tenant_id AND agent_id=NEW.agent_id AND version=NEW.version)
    BEGIN SELECT RAISE(ABORT,'Agent definition versions are immutable'); END;
   CREATE TRIGGER IF NOT EXISTS agent_definitions_no_update BEFORE UPDATE ON agent_definitions BEGIN SELECT RAISE(ABORT,'Agent definition versions are immutable'); END;
   CREATE TRIGGER IF NOT EXISTS agent_definitions_no_delete BEFORE DELETE ON agent_definitions BEGIN SELECT RAISE(ABORT,'Agent definition versions are immutable'); END;`);
  }catch(error){this.db.close();throw error;}
 }
 close():void{this.db.close();}
 private parse(row:Record<string,unknown>,tenantId:string,agentId:string):AgentDefinitionVersion {
  const version=Number(row.version);if(!Number.isSafeInteger(version)||version<1||typeof row.manifest!=='string')throw Error('Invalid stored agent definition');
  const manifest=validateAgentManifest(JSON.parse(row.manifest));if(manifest.tenantId!==tenantId||manifest.agentId!==agentId)throw Error('Invalid stored agent definition');return {version,manifest};
 }
 get(tenantId:string,agentId:string,version?:number):AgentDefinitionVersion|undefined {
  key(tenantId);key(agentId);if(version!==undefined&&(!Number.isSafeInteger(version)||version<1))throw Error('Invalid agent version');
  const row=version===undefined?this.db.prepare('SELECT version,manifest FROM agent_definitions WHERE tenant_id=? AND agent_id=? ORDER BY version DESC LIMIT 1').get(tenantId,agentId):this.db.prepare('SELECT version,manifest FROM agent_definitions WHERE tenant_id=? AND agent_id=? AND version=?').get(tenantId,agentId,version);
  return row?this.parse(row,tenantId,agentId):undefined;
 }
 list(tenantId:string,options:{after?:string;limit?:number}={}):AgentDefinitionVersion[]{
  key(tenantId);if(!options||typeof options!=='object'||(options.after!==undefined&&!identifier.safeParse(options.after).success)||!Number.isSafeInteger(options.limit??100)||(options.limit??100)<1||(options.limit??100)>100)throw Error('Invalid agent listing');
  const rows=this.db.prepare(`SELECT a.agent_id,a.version,a.manifest FROM agent_definitions a WHERE a.tenant_id=? AND a.agent_id>? AND a.version=(SELECT MAX(b.version) FROM agent_definitions b WHERE b.tenant_id=a.tenant_id AND b.agent_id=a.agent_id) ORDER BY a.agent_id LIMIT ?`).all(tenantId,options.after??'',options.limit??100);
  return rows.map(row=>this.parse(row,tenantId,String(row.agent_id)));
 }
 save(tenantId:string,input:unknown,expectedVersion:number):AgentDefinitionVersion {
  key(tenantId);if(!Number.isSafeInteger(expectedVersion)||expectedVersion<0||expectedVersion>=Number.MAX_SAFE_INTEGER)throw Error('Invalid agent version');
  const manifest=validateAgentManifest(input);if(manifest.tenantId!==tenantId)throw Error('Agent scope mismatch');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const current=this.get(tenantId,manifest.agentId)?.version??0;if(current!==expectedVersion)throw Error('Agent version conflict');
   const version=current+1;this.db.prepare('INSERT INTO agent_definitions VALUES (?,?,?,?)').run(tenantId,manifest.agentId,version,JSON.stringify(manifest));
   this.db.exec('COMMIT');return {version,manifest:structuredClone(manifest)};
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
}
