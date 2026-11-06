# Runbooks

One section per alert in [`deploy/observability/prometheus-alerts.yml`](../deploy/observability/prometheus-alerts.yml). Each section says what the alert means, what to check first and how to resolve it with the APIs App Mixer provides. A test checks that every alert has a section here and that every metric and label value an alert uses is one the product emits.

The rules are starting points. Tune thresholds and `for:` durations to your SLOs, keep the job names (`app-mixer-data-plane`, `app-mixer-agent`) or update the expressions, and route `severity: page` and `severity: ticket` in Alertmanager. [`alertmanager-example.yml`](../deploy/observability/alertmanager-example.yml) is a starting routing tree: pages to an on-call receiver, everything else to tickets, resolved notices on, and ticket alerts for a target suppressed while its scrape is failing. Replace its two placeholder webhook URLs with your integrations. [`grafana-dashboard.json`](../deploy/observability/grafana-dashboard.json) is a starting Grafana dashboard (import it and pick the Prometheus data source) with request rate, error ratio, p50 and p99 latency, publication version, draining, uptime, durable runs and actions by status, and overdue and due-schedule age; a test checks that every query uses only emitted metrics and labels, and each query was also parsed by a real Prometheus. App Mixer does not provide on-call schedules, paging or ticketing services, or a hosted dashboard service.

The failure drill in `packages/cli/test/alert-rules.test.mjs` (`APP_MIXER_TEST_PROMETHEUS=docker`, run in CI) loads both files into real Prometheus and Alertmanager containers with the `for:` durations and grouping timings shortened, scrapes the real metrics servers, breaks them (no schedule worker, an uncertain action, a pod stuck draining, then a metrics endpoint gone), and checks that each alert reaches the right webhook receiver with its runbook and that resolved notices follow recovery.
The rules are starting points. Tune thresholds and `for:` durations to your SLOs, keep the job names (`app-mixer-data-plane`, `app-mixer-agent`) or update the expressions, and route `severity: page` and `severity: ticket` in Alertmanager. App Mixer does not ship Alertmanager routes, on-call schedules or dashboards.

## AppMixerMetricsScrapeFailing

**Meaning:** Prometheus has failed to scrape an App Mixer metrics endpoint for 5 minutes, so every other alert for that target is blind.

**Check:** the target's last error on the Prometheus targets page. A 401 or 403 means the scraper's credentials no longer pass the host's `authorize` or `authenticate` callback; a 503 means the scrape timed out or `maxPending` is exhausted (see [metrics server](data-plane-observability.md)); a connection error means the process or its separate metrics listener is down.

**Resolve:** restore the process or listener, or rotate the scraper credential on both sides. If 503s persist, look for a slow authorization callback or database before raising `timeoutMs`.

## AppMixerDataPlaneErrorRate

**Meaning:** more than 5% of completed Data Plane requests returned 5xx for 10 minutes. Aborted requests are not counted as errors.

**Check:** which `route` carries the errors (`sum by (route) (rate(app_mixer_data_plane_requests_total{status_class="5xx"}[5m]))`). Errors on `ready` alone usually mean readiness is failing on purpose (draining or a failed publication load); errors on `application` mean the repository or signature verification is failing.

**Resolve:** check the Data Plane logs for repository or verification failures. If a new publication caused it, roll back through the release journal rather than editing the database. If the repository is unavailable, restore it; the Data Plane does not cache around a failing store.

## AppMixerDataPlaneSlowApplication

**Meaning:** the 99th percentile of completed application responses has been above one second for 15 minutes.

**Check:** whether slowness follows publication size (larger definitions), repository latency, or CPU throttling of the pod. Histogram buckets stop at 10 seconds, so a quantile at 10 means "10 seconds or more".

**Resolve:** reduce publication size, fix repository latency, or raise CPU limits. Aggregate buckets across pods as the rule does; do not average per-pod percentiles.

## AppMixerDataPlaneStuckDraining

**Meaning:** a process has reported `app_mixer_data_plane_draining 1` for 2 minutes, longer than the 30 second `terminationGracePeriodSeconds` in the Kubernetes manifest allows.

**Check:** whether the pod is still terminating (`kubectl get pod`) and whether long-lived connections are keeping it open. A process outside Kubernetes may have been told to drain and never stopped.

**Resolve:** let the orchestrator kill the pod, or stop the process. If this happens on every rollout, find the connections that outlive the grace period instead of raising it blindly.

## AppMixerDataPlaneVersionSkew

**Meaning:** processes in one job have reported different publication versions for 15 minutes. A rollout normally converges within minutes.

**Check:** `count_values by (job) ("version", app_mixer_data_plane_publication_version)` to see which versions are served and by how many pods, then compare with the release journal. A version gauge shows what a process loaded, not that it is the approved release.

**Resolve:** finish or roll back the rollout so every pod serves the journal's current version. Pods stuck on an old version usually failed to load the new publication; check their logs for signature or digest errors.

## AppMixerDataPlaneRestarting

**Meaning:** a process's start time changed more than twice in 30 minutes, so it is crash-looping or being restarted by probes.

**Check:** the container's exit reason and last logs, and whether liveness failures are restarting it (probe timeouts under CPU starvation are a common cause).

**Resolve:** fix the crash, or give the process enough CPU and memory to answer probes. Do not loosen liveness probes to hide a crash.

## AppMixerAgentScheduleBacklog

**Meaning:** an enabled schedule's occurrence has been due for more than 5 minutes without firing. No `AgentScheduleWorker` is firing for this scope, or the pending-run limit is holding occurrences back.

**Check:** whether the worker process is running and ready (`AgentWorkerHost.ready()` reports this), whether it serves this tenant and agent, and whether `app_mixer_agent_runs{status="queued"}` is at the schedule's `maxPending` limit.

**Resolve:** start or restart the worker host. If runs are piling up, fix the run worker first; firing more occurrences into a full queue does not help. By default missed occurrences then fire one per schedule per polling pass, so a long outage drains gradually; schedules with `misfire: 'coalesce'` enqueue one run for the whole missed interval (see [agent schedules](agent-schedules.md)).

## AppMixerAgentRunsOverdue

**Meaning:** a queued or paused run has been past its deadline, or a running, pause-requested or cancel-requested run has been past its lease expiry, for more than 5 minutes. The `kind` label says which (`queued`, `paused`, `lease`).

**Check:** for `lease`, whether the worker holding the lease is still alive. For `queued` or `paused`, whether the run worker and `AgentRunExpiryWorker` are running.

**Resolve:** for expired leases, establish that the old worker has stopped, then call `recoverExpired` so the run becomes `uncertain`, and reconcile it (see the next runbook). For expired queued or paused runs, run `AgentRunExpiryWorker`; it fails closed while unresolved action dispatches exist, so resolve those first. See [durable agent runs](durable-agent-runs.md).

## AppMixerAgentRunsUncertain

**Meaning:** runs are in `uncertain`: a worker crashed, lost its lease or returned an outcome it could not substantiate, so App Mixer does not know whether the run's effects happened.

**Check:** the run's journaled actions (`journal.list({status: 'uncertain'})`) and the external systems they called, using each action's idempotency key.

**Resolve:** reconcile each action with `reconcileWith` or `reconcileWithEvidence` (or run `AgentActionRecoveryWorker`), then settle the run. Never re-run an uncertain run without reconciling; a duplicate external effect is the failure this state exists to prevent. See [agent action journal](agent-action-journal.md).

## AppMixerAgentActionsUncertain

**Meaning:** journaled actions have an unknown outcome for 15 minutes.

**Check:** whether `AgentActionRecoveryWorker` is running for this journal and what its verifier returns; `unknown` and verifier errors leave the action uncertain.

**Resolve:** fix the verifier or its access to the external system, or decide manually with `reconcileWithEvidence` and a reference to the supporting evidence. A confirmed `not_applied` allows a retry with the same idempotency key.

## AppMixerAgentActionsDispatchingStuck

**Meaning:** actions have stayed in `dispatching` for 30 minutes. A live dispatch finishes much sooner, so the worker that started it has probably crashed or lost its lease.

**Check:** that the worker holding the run's lease is gone.

**Resolve:** stop the old worker, move the run to `uncertain` (`recoverExpired`), call `markUncertain` for the stranded dispatches, then reconcile as for uncertain actions. Do not mark a dispatch uncertain while its worker may still be running.

## Stranded staged business operations

**Meaning:** a staged external operation stayed `submitting` or `uncertain`, so the customer may or may not have the effect and nothing will retry it.

**Check:** `staged.list(scope, {status: 'submitting'})` and `{status: 'uncertain'}` (paginate with `next`). For each, confirm in the external system whether the effect with the operation's idempotency key happened; for `submitting`, first confirm that the submitting process is gone.

**Resolve:** call `recoverAbandoned` for a `submitting` record whose process is gone, then `reconcileWithEvidence` (or `reconcile`) with `applied` or `not_applied`. `not_applied` makes the intent eligible for a new submission with the same key; never mark it so without evidence.

## Stranded offline operations

**Meaning:** an offline queue item is `uncertain`, `conflict` or `running` for longer than a worker pass, or a shared execution is `running` or `uncertain`; nothing retries it automatically.

**Check:** `queue.listAll(scope, {status})` and `executions.list(scope, {status})` for `uncertain` and `running`, paging with `next`. For `running`, confirm that the submitting process is gone before touching it.

**Resolve:** `recoverAbandoned` (queue) or `markUncertain` (shared execution, with the listed attempt token) for abandoned `running` work, then verify the outcome with the remote system and `reconcile` with `applied` or `not_applied`. `conflict` items need a user or operator decision (`discard`).
