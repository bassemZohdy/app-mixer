#!/bin/sh
# Schedules PostgresRunSupervisor workers as a two-replica Deployment, crashes one worker process mid-run, rolls the
# Deployment (graceful drain) and verifies every run finished with each external effect applied exactly once.
set -eu
ns=${1:-agent-recovery-test}
dir=deploy/kubernetes/test-support/agent-recovery
script=$dir/run-supervisor.mjs
runs=60
k() { kubectl -n "$ns" "$@"; }
kubectl get namespace "$ns" >/dev/null 2>&1 || kubectl create namespace "$ns"
k apply -f "$dir/postgres.yaml" -f "$dir/run-supervisor.yaml"
k wait --for=condition=Ready pod/agent-memory-postgres pod/agent-run-effects --timeout=180s
ready=false
for i in $(seq 1 60); do
  if k exec agent-run-effects -- node "$script" setup "$runs"; then ready=true; break; fi
  sleep 1
done
[ "$ready" = true ]
k scale deployment/agent-run-workers --replicas=2
k rollout status deployment/agent-run-workers --timeout=180s
pod=$(k get pods -l app=agent-run-workers -o jsonpath='{.items[0].metadata.name}')
holding=false
for i in $(seq 1 120); do
  if k exec agent-run-effects -- node "$script" holding "$pod"; then holding=true; break; fi
  sleep 0.5
done
[ "$holding" = true ]
# Crash the worker process (SIGKILL, no drain) while it holds a run; the container restarts in place.
k exec "$pod" -- sh -c 'kill -9 "$(cat /tmp/worker.pid)"'
echo "crashed the worker in $pod"
restarted=false
for i in $(seq 1 60); do
  if [ "$(k get pod "$pod" -o jsonpath='{.status.containerStatuses[0].restartCount}')" -ge 1 ]; then restarted=true; break; fi
  sleep 1
done
[ "$restarted" = true ]
# Roll the Deployment: each old worker gets SIGTERM, stops claiming and finishes the runs it holds.
k rollout restart deployment/agent-run-workers
k rollout status deployment/agent-run-workers --timeout=300s
finished=false
for i in $(seq 1 180); do
  if k exec agent-run-effects -- node "$script" done; then finished=true; break; fi
  sleep 1
done
[ "$finished" = true ]
k exec agent-run-effects -- node "$script" verify "$runs"
