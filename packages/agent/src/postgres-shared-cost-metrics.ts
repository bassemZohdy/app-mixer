import { PostgresAgentSharedCost, type SharedCostActor, type SharedCostMetricsSnapshot } from './postgres-agent-shared-cost.js';
/** Separately authorized aggregate metrics for one fixed shared cost budget. */
export class PostgresAgentSharedCostMetrics {
  private readonly ledger: PostgresAgentSharedCost;
  constructor(ledger: PostgresAgentSharedCost) {
    if (!(ledger instanceof PostgresAgentSharedCost)) throw Error('Invalid shared cost metrics configuration');
    this.ledger = ledger;
  }
  snapshot(actor: SharedCostActor): Promise<SharedCostMetricsSnapshot> {
    return this.ledger.metricsSnapshot(actor);
  }
  async render(actor: SharedCostActor): Promise<string> {
    return this.renderWithSignal(actor, new AbortController().signal);
  }
  async renderWithSignal(actor: SharedCostActor, signal: AbortSignal): Promise<string> {
    const s = await this.ledger.metricsSnapshotWithSignal(actor, signal);
    return `# HELP app_mixer_shared_cost_limit_micros Fixed shared budget limit in currency millionths.
# TYPE app_mixer_shared_cost_limit_micros gauge
app_mixer_shared_cost_limit_micros ${s.limitMicros}
# HELP app_mixer_shared_cost_reserved_micros Cost held by outstanding calls.
# TYPE app_mixer_shared_cost_reserved_micros gauge
app_mixer_shared_cost_reserved_micros ${s.reservedMicros}
# HELP app_mixer_shared_cost_committed_micros Cost reported or reconciled by settled calls.
# TYPE app_mixer_shared_cost_committed_micros gauge
app_mixer_shared_cost_committed_micros ${s.committedMicros}
# HELP app_mixer_shared_cost_calls Shared cost calls by fixed state.
# TYPE app_mixer_shared_cost_calls gauge
app_mixer_shared_cost_calls{state="reserved"} ${s.reservedCalls}
app_mixer_shared_cost_calls{state="settled"} ${s.settledCalls}
# HELP app_mixer_shared_cost_overrun_calls Settled calls above their reservation.
# TYPE app_mixer_shared_cost_overrun_calls gauge
app_mixer_shared_cost_overrun_calls ${s.overrunCalls}
# HELP app_mixer_shared_cost_oldest_reservation_seconds Age of the oldest outstanding reservation.
# TYPE app_mixer_shared_cost_oldest_reservation_seconds gauge
app_mixer_shared_cost_oldest_reservation_seconds ${s.oldestReservationSeconds}
`;
  }
}
