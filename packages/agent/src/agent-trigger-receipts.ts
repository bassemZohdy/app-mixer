import {type DatabaseSync} from 'node:sqlite';

/** Additive receipt metadata; historical inbox entries are intentionally not backfilled. */
export function ensureTriggerReceiptSchema(db:DatabaseSync):void{
 db.exec(`CREATE TABLE IF NOT EXISTS agent_trigger_receipts (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,received_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,agent_id,run_id));
 CREATE TRIGGER IF NOT EXISTS agent_trigger_receipts_no_replace BEFORE INSERT ON agent_trigger_receipts WHEN EXISTS(SELECT 1 FROM agent_trigger_receipts WHERE tenant_id=NEW.tenant_id AND agent_id=NEW.agent_id AND run_id=NEW.run_id) BEGIN SELECT RAISE(ABORT,'Trigger receipts are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS agent_trigger_receipts_no_update BEFORE UPDATE ON agent_trigger_receipts BEGIN SELECT RAISE(ABORT,'Trigger receipts are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS agent_trigger_receipts_no_delete BEFORE DELETE ON agent_trigger_receipts BEGIN SELECT RAISE(ABORT,'Trigger receipts are immutable'); END;`);
}
