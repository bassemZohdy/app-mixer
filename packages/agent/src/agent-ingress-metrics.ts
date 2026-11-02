import type {AgentEventIngressObservation} from './event-ingress.js';
import type {AgentRunMetricsActor} from './agent-run-metrics.js';

const outcomes=['accepted','completed','rejected','unavailable','disconnected'] as const;
type Outcome=typeof outcomes[number];
const valid=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);
export type AgentIngressMetricsOptions={authorize:(actor:AgentRunMetricsActor)=>boolean|Promise<boolean>};

/** Process-wide ingress response metrics; host policy must authorize the whole aggregate. */
export class AgentIngressMetrics {
 private readonly authorize:AgentIngressMetricsOptions['authorize'];
 private readonly counts:Record<Outcome,number>={accepted:0,completed:0,rejected:0,unavailable:0,disconnected:0};
 private count=0;private durationSeconds=0;
 constructor(options:AgentIngressMetricsOptions){if(!options||typeof options.authorize!=='function')throw Error('Invalid ingress metrics configuration');this.authorize=options.authorize;}
 /** Pass this function as the event ingress observe callback. */
 readonly observe=(observation:AgentEventIngressObservation):void=>{
  if(!observation||!outcomes.includes(observation.outcome)||typeof observation.durationMs!=='number'||!Number.isFinite(observation.durationMs)||observation.durationMs<0)throw Error('Invalid ingress observation');
  const next=this.durationSeconds+observation.durationMs/1000;if(!Number.isFinite(next)||this.count>=Number.MAX_SAFE_INTEGER||this.counts[observation.outcome]>=Number.MAX_SAFE_INTEGER)throw Error('Ingress metrics exhausted');
  this.counts[observation.outcome]++;this.count++;this.durationSeconds=next;
 };
 private actor(actor:AgentRunMetricsActor):AgentRunMetricsActor{if(!actor||!valid(actor.tenantId)||!valid(actor.principalId))throw Error('Invalid agent metrics actor');return {tenantId:actor.tenantId,principalId:actor.principalId};}
 private async permit(actor:AgentRunMetricsActor):Promise<void>{try{if(await this.authorize({...actor})===true)return;}catch{}throw Error('Agent metrics access denied');}
 /** Authorization covers all events observed by this instance, potentially across tenants. */
 async render(actor:AgentRunMetricsActor):Promise<string>{const who=this.actor(actor);await this.permit(who);const counts={...this.counts},count=this.count,sum=this.durationSeconds;await this.permit(who);return ['# HELP app_mixer_agent_ingress_requests_total Agent ingress responses by fixed outcome.','# TYPE app_mixer_agent_ingress_requests_total counter',...outcomes.map(outcome=>`app_mixer_agent_ingress_requests_total{outcome="${outcome}"} ${counts[outcome]}`),'# HELP app_mixer_agent_ingress_response_seconds Total response observation duration in seconds.','# TYPE app_mixer_agent_ingress_response_seconds summary',`app_mixer_agent_ingress_response_seconds_sum ${sum}`,`app_mixer_agent_ingress_response_seconds_count ${count}`,''].join('\n');}
}
