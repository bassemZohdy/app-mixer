/** Experimental shared-run interface. The host is responsible for identity, policy, database timeouts and reconciliation. */
import {PostgresAgentTriggerFoundation} from './postgres-trigger-foundation.js';
import {PostgresAgentRunLifecycleFoundation} from './postgres-run-lifecycle-foundation.js';
import {PostgresAgentActionJournalFoundation} from './postgres-action-journal-foundation.js';
import {PostgresAgentTokenBudgetFoundation} from './postgres-token-budget-foundation.js';
import {PostgresAgentCheckpointerFoundation} from './postgres-checkpointer-foundation.js';
import {PostgresAgentApprovalsFoundation} from './postgres-agent-approvals-foundation.js';
import {PostgresAgentSchedulesFoundation} from './postgres-agent-schedules-foundation.js';
import {PostgresAgentDelegationsFoundation} from './postgres-agent-delegations-foundation.js';

type Database=Pick<ConstructorParameters<typeof PostgresAgentTriggerFoundation>[0],'query'|'transaction'>;
/** Provision before starting workers, using one schema provisioner. This creates no run or grant. */
export async function initializeExperimentalSharedAgentStorage(database:Database):Promise<{triggers:PostgresAgentTriggerFoundation;runs:PostgresAgentRunLifecycleFoundation;schedules:PostgresAgentSchedulesFoundation}>{
 if(!database||typeof database.query!=='function'||typeof database.transaction!=='function')throw Error('Invalid shared storage configuration');const config={query:database.query,transaction:database.transaction},triggers=new PostgresAgentTriggerFoundation(config),runs=new PostgresAgentRunLifecycleFoundation(config),schedules=new PostgresAgentSchedulesFoundation(config);await triggers.initialize();await runs.initialize();const ddlOnly={...config,scope:{tenantId:'schema-provisioner',agentId:'schema-provisioner'},runId:'schema-provisioner',leaseToken:'schema-provisioner'};await new PostgresAgentActionJournalFoundation(ddlOnly).initialize();await new PostgresAgentTokenBudgetFoundation({...ddlOnly,maxTokens:1}).initialize();await new PostgresAgentCheckpointerFoundation(ddlOnly).initialize();await new PostgresAgentApprovalsFoundation({...ddlOnly,authorize:()=>false}).initialize();await new PostgresAgentDelegationsFoundation({...ddlOnly,authorize:()=>false}).initialize();await schedules.initialize();return {triggers,runs,schedules};
}
export {PostgresAgentTriggerFoundation,PostgresAgentRunLifecycleFoundation,PostgresAgentActionJournalFoundation,PostgresAgentTokenBudgetFoundation,PostgresAgentCheckpointerFoundation,PostgresAgentApprovalsFoundation,PostgresAgentSchedulesFoundation,PostgresAgentDelegationsFoundation};
export {PostgresAgentWorkerFoundation} from './postgres-worker-foundation.js';
export {PostgresAgentDispatcherFoundation} from './postgres-dispatcher-foundation.js';
export {PostgresAgentWakeupRetentionFoundation} from './postgres-wakeup-retention-foundation.js';
export {PostgresAgentTriggerRetentionFoundation} from './postgres-trigger-retention-foundation.js';
export {PostgresAgentNoticesFoundation} from './postgres-agent-notices-foundation.js';
export {PostgresAgentExpiryHistoryFoundation} from './postgres-expiry-history-foundation.js';
export {PostgresAgentLeaseRecoveryHistoryFoundation} from './postgres-lease-recovery-history-foundation.js';
export {PostgresAgentActionRecoveryDiscoveryFoundation,PostgresAgentBudgetRecoveryDiscoveryFoundation} from './postgres-recovery-discovery-foundation.js';
export {registerSharedAgentRunReconciliation} from './postgres-run-reconciliation-capability.js';
export type {Database as ExperimentalSharedAgentDatabase};
