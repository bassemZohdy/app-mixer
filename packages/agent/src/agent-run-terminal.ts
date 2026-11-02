import {type DatabaseSync} from 'node:sqlite';

/** Additive terminal-time metadata; existing runs are not backfilled. */
export function ensureAgentRunTerminalSchema(db:DatabaseSync):void{
 db.exec(`CREATE TABLE IF NOT EXISTS agent_run_terminal_times (tenant_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,completed_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,agent_id,run_id));
 CREATE TRIGGER IF NOT EXISTS agent_run_terminal_no_replace BEFORE INSERT ON agent_run_terminal_times WHEN EXISTS(SELECT 1 FROM agent_run_terminal_times WHERE tenant_id=NEW.tenant_id AND agent_id=NEW.agent_id AND run_id=NEW.run_id) BEGIN SELECT RAISE(ABORT,'Run terminal times are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS agent_run_terminal_no_update BEFORE UPDATE ON agent_run_terminal_times BEGIN SELECT RAISE(ABORT,'Run terminal times are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS agent_run_terminal_no_delete BEFORE DELETE ON agent_run_terminal_times BEGIN SELECT RAISE(ABORT,'Run terminal times are immutable'); END;`);
}
