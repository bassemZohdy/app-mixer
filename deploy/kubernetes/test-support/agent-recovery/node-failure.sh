#!/bin/sh
# Takes a whole Kubernetes node down while a scheduled run worker on it holds a run, and verifies that the Deployment replaces the
# lost pod on a surviving node and every run still finishes with each external effect applied exactly once. Needs a kind cluster with
# two worker nodes (see .github/workflows/agent-node-failure.yml); the PostgreSQL and effects pods are kept on the first worker.
#   sh deploy/kubernetes/test-support/agent-recovery/node-failure.sh [namespace] [cluster]
set -eu
ns=${1:-agent-node-failure}
cluster=${2:-node-failure}
survivor=$cluster-worker
victim=$cluster-worker2
dir=deploy/kubernetes/test-support/agent-recovery
script=$dir/run-supervisor.mjs
runs=60
k() { kubectl -n "$ns" "$@"; }
kubectl get namespace "$ns" >/dev/null 2>&1 || kubectl create namespace "$ns"

# Keep the stateful pods off the node that will fail: with the victim cordoned they can only land on the survivor. The trap uncordons the
# victim again if the script stops early, so a failed run does not leave the cluster without a schedulable second worker.
trap 'kubectl uncordon "$victim" >/dev/null 2>&1 || true' EXIT
kubectl cordon "$victim"
k apply -f "$dir/postgres.yaml" -f "$dir/run-supervisor.yaml"
k wait --for=condition=Ready pod/agent-memory-postgres pod/agent-run-effects --timeout=180s
kubectl uncordon "$victim"
for pod in agent-memory-postgres agent-run-effects; do
  [ "$(k get pod "$pod" -o jsonpath='{.spec.nodeName}')" = "$survivor" ]
done

ready=false
for i in $(seq 1 60); do
  if k exec agent-run-effects -- node "$script" setup "$runs"; then ready=true; break; fi
  sleep 1
done
[ "$ready" = true ]

# Evict from an unreachable or not-ready node after 5 seconds instead of the default 300.
k patch deployment/agent-run-workers --type merge -p '{"spec":{"template":{"spec":{
  "tolerations":[
    {"key":"node.kubernetes.io/unreachable","operator":"Exists","effect":"NoExecute","tolerationSeconds":5},
    {"key":"node.kubernetes.io/not-ready","operator":"Exists","effect":"NoExecute","tolerationSeconds":5}]}}}}'
# Place one worker on each node deterministically: cordon the survivor so the first pod lands on the victim, then cordon the victim so the
# second lands on the survivor. Pods that are already running are not moved by a cordon.
kubectl cordon "$survivor"
kubectl uncordon "$victim"
k scale deployment/agent-run-workers --replicas=1
k rollout status deployment/agent-run-workers --timeout=180s
kubectl uncordon "$survivor"
kubectl cordon "$victim"
k scale deployment/agent-run-workers --replicas=2
k rollout status deployment/agent-run-workers --timeout=180s
kubectl uncordon "$victim"

pod=
for candidate in $(k get pods -l app=agent-run-workers -o jsonpath='{.items[*].metadata.name}'); do
  if [ "$(k get pod "$candidate" -o jsonpath='{.spec.nodeName}')" = "$victim" ]; then pod=$candidate; fi
done
if [ -z "$pod" ]; then
  echo "no worker was scheduled on $victim"; k get pods -o wide; exit 1
fi
holding=false
for i in $(seq 1 120); do
  if k exec agent-run-effects -- node "$script" holding "$pod"; then holding=true; break; fi
  sleep 0.5
done
[ "$holding" = true ]

started=$(date +%s)
docker kill "$victim" >/dev/null
echo "killed node $victim while $pod held a run"

# The control plane marks the node NotReady, evicts the pod, and the Deployment starts a replacement on the survivor.
replaced=false
for i in $(seq 1 300); do
  count=$(k get pods -l app=agent-run-workers --field-selector spec.nodeName="$survivor",status.phase=Running -o name | wc -l)
  if [ "$count" -ge 2 ]; then replaced=true; break; fi
  sleep 1
done
[ "$replaced" = true ]
echo "two workers were running on $survivor again $(( $(date +%s) - started )) seconds after the node was killed"

finished=false
for i in $(seq 1 300); do
  if k exec agent-run-effects -- node "$script" done; then finished=true; break; fi
  sleep 1
done
[ "$finished" = true ]
echo "every run finished $(( $(date +%s) - started )) seconds after the node was killed"
# At least two worker pods did work: the one on the lost node and the one on the survivor, which took over the lost pod's runs after their leases
# expired. The replacement for the lost pod may or may not have started before the runs finished, so it is not required.
k exec agent-run-effects -- node "$script" verify "$runs" 2
