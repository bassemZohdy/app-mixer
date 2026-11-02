import type {AgentActionRecoveryObservation} from './action-recovery-worker.js';
import type {AgentRunMetricsActor} from './agent-run-metrics.js';

const outcomes=['completed','failed','stopped'] as const;
type Outcome=typeof outcomes[number];
const valid=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);
export type AgentActionRecoveryMetricsOptions={authorize:(actor:AgentRunMetricsActor)=>boolean|Promise<boolean>};

/** Process-local worker pass observations; policy must authorize the full aggregate. */
export class AgentActionRecoveryMetrics{
 private readonly authorize:AgentActionRecoveryMetricsOptions['authorize'];
 private readonly counts:Record<Outcome,number>={completed:0,failed:0,stopped:0};
 private reconciled=0;private durationSeconds=0;private count=0;
 constructor(options:AgentActionRecoveryMetricsOptions){if(!options||typeof options.authorize!=='function')throw Error('Invalid action recovery metrics configuration');this.authorize=options.authorize;}
 readonly observe=(observation:AgentActionRecoveryObservation):void=>{
  if(!observation||!outcomes.includes(observation.outcome)||!Number.isSafeInteger(observation.reconciled)||observation.reconciled<0||observation.reconciled>100||typeof observation.durationMs!=='number'||!Number.isFinite(observation.durationMs)||observation.durationMs<0)throw Error('Invalid action recovery observation');
  const sum=this.durationSeconds+observation.durationMs/1000,total=this.reconciled+observation.reconciled;if(!Number.isFinite(sum)||!Number.isSafeInteger(total)||this.count>=Number.MAX_SAFE_INTEGER||this.counts[observation.outcome]>=Number.MAX_SAFE_INTEGER)throw Error('Action recovery metrics exhausted');
  this.counts[observation.outcome]++;this.reconciled=total;this.durationSeconds=sum;this.count++;
 };
 private async permit(actor:AgentRunMetricsActor):Promise<void>{try{if(await this.authorize({...actor})===true)return;}catch{}throw Error('Agent metrics access denied');}
 async render(actor:AgentRunMetricsActor):Promise<string>{if(!actor||!valid(actor.tenantId)||!valid(actor.principalId))throw Error('Invalid agent metrics actor');const who={tenantId:actor.tenantId,principalId:actor.principalId};await this.permit(who);const counts={...this.counts},reconciled=this.reconciled,sum=this.durationSeconds,count=this.count;await this.permit(who);return ['# HELP app_mixer_agent_action_recovery_passes_total Action recovery worker passes by fixed outcome.','# TYPE app_mixer_agent_action_recovery_passes_total counter',...outcomes.map(outcome=>`app_mixer_agent_action_recovery_passes_total{outcome="${outcome}"} ${counts[outcome]}`),'# HELP app_mixer_agent_action_recovery_reconciled_total Actions reconciled by observed worker passes.','# TYPE app_mixer_agent_action_recovery_reconciled_total counter',`app_mixer_agent_action_recovery_reconciled_total ${reconciled}`,'# HELP app_mixer_agent_action_recovery_pass_seconds Action recovery pass duration in seconds.','# TYPE app_mixer_agent_action_recovery_pass_seconds summary',`app_mixer_agent_action_recovery_pass_seconds_sum ${sum}`,`app_mixer_agent_action_recovery_pass_seconds_count ${count}`,''].join('\n');}
}
