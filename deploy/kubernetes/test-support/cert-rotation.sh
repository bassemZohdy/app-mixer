#!/bin/bash
# cert-manager issues the Data Plane's server certificate in a cluster; the script renews it and then rotates the CA,
# and checks what clients see on every replica while the pods keep running:
#   1. the certificate is issued and verifies against the CA and the service name;
#   2. a manual renewal gives each pod a new certificate (new serial, new key) with no restart;
#   3. a client with a CA bundle (old and new CA) keeps verifying before, during and after the issuer changes,
#      a client with only the old CA stops verifying once the leaf comes from the new CA, and one with only the new CA
#      verifies.
# Needs kubectl on a cluster that has the app-mixer-data-plane:test image, openssl and bash.
set -eu
ns=app-mixer-test
dir=deploy/kubernetes
version=${CERT_MANAGER_VERSION:-v1.18.2}
name=app-mixer-data-plane.$ns.svc
work=$(mktemp -d)
fwd=
cleanup() { [ -n "$fwd" ] && kill "$fwd" 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT

k() { kubectl -n "$ns" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

kubectl get namespace "$ns" >/dev/null 2>&1 || kubectl create namespace "$ns"
kubectl apply -f "https://github.com/cert-manager/cert-manager/releases/download/$version/cert-manager.yaml"
for d in cert-manager cert-manager-cainjector cert-manager-webhook; do kubectl -n cert-manager rollout status "deployment/$d" --timeout=300s; done
applied=false
for i in $(seq 1 40); do
  if kubectl apply -n "$ns" -k "$dir/cert-manager-tls-example"; then applied=true; break; fi
  sleep 5
done
[ "$applied" = true ] || fail "could not apply the example (is the cert-manager webhook ready?)"
k wait --for=condition=Ready certificate/app-mixer-data-plane-tls --timeout=240s
k rollout status deployment/app-mixer-data-plane --timeout=240s

# Running pods that are not being deleted (a pod from a previous rollout may still be terminating).
pods=$(k get pods -l app.kubernetes.io/component=data-plane --field-selector=status.phase=Running -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.deletionTimestamp}{"\n"}{end}' | awk 'NF==1{print $1}')
[ "$(echo $pods | wc -w)" -ge 2 ] || fail "expected two running pods, got: $pods"
for pod in $pods; do echo "$(k get pod "$pod" -o jsonpath='{.metadata.uid} {.status.containerStatuses[0].restartCount}')" > "$work/$pod.before"; done

port=14000
# leaf <pod>: writes the certificate the pod serves to $work/<pod>.pem
leaf() {
  port=$((port + 1))
  kubectl -n "$ns" port-forward "pod/$1" "$port:3002" >"$work/forward.log" 2>&1 &
  fwd=$!
  local ok=false
  for i in $(seq 1 40); do
    if openssl s_client -connect "127.0.0.1:$port" -servername "$name" </dev/null 2>/dev/null | openssl x509 -out "$work/$1.pem" 2>/dev/null; then ok=true; break; fi
    sleep 0.5
  done
  kill "$fwd" 2>/dev/null || true; wait "$fwd" 2>/dev/null || true; fwd=
  [ "$ok" = true ] || { cat "$work/forward.log" >&2; fail "could not read the certificate served by $1"; }
}
serial() { openssl x509 -noout -serial -in "$work/$1.pem"; }
keyid() { openssl x509 -noout -pubkey -in "$work/$1.pem" | openssl sha256 | awk '{print $NF}'; }
# verifies <pod> <ca file>: does the pod's current certificate verify for the service name?
verifies() { openssl verify -purpose sslserver -verify_hostname "$name" -CAfile "$2" "$work/$1.pem" >/dev/null 2>&1; }
revision() { k get certificate app-mixer-data-plane-tls -o jsonpath='{.status.revision}'; }
wait_ready() { k wait --for=condition=Ready certificate/app-mixer-data-plane-tls --timeout=240s; }
# every pod serves a new certificate (a serial different from the one recorded in $work/<pod>.serial)
wait_new_certificates() {
  for i in $(seq 1 60); do
    local changed=0
    for pod in $pods; do leaf "$pod"; [ "$(serial "$pod")" != "$(cat "$work/$pod.serial")" ] && changed=$((changed + 1)); done
    if [ "$changed" -eq "$(echo $pods | wc -w)" ]; then
      for pod in $pods; do serial "$pod" > "$work/$pod.serial"; keyid "$pod" > "$work/$pod.key"; done
      return 0
    fi
    sleep 5
  done
  fail "a pod still serves the old certificate after 5 minutes"
}
record() { for pod in $pods; do leaf "$pod"; serial "$pod" > "$work/$pod.serial"; keyid "$pod" > "$work/$pod.key"; done; }
# The CA certificate is the CA Secret's certificate (it is self-signed).
ca() { k get secret "$1" -o jsonpath='{.data.tls\.crt}' | base64 -d; }
ca app-mixer-ca > "$work/ca1.pem"

echo "== 1. issuance"
record
for pod in $pods; do verifies "$pod" "$work/ca1.pem" || fail "$pod's certificate does not verify against the CA for $name"; echo "$pod serves $(cat "$work/$pod.serial") (verified)"; done
if openssl verify -purpose sslserver -verify_hostname wrong.example -CAfile "$work/ca1.pem" "$work/$(echo $pods | cut -d' ' -f1).pem" >/dev/null 2>&1; then fail "the certificate verified for a wrong host name"; fi

echo "== 2. renewal without a restart"
rev=$(revision)
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gen=$(k get certificate app-mixer-data-plane-tls -o jsonpath='{.metadata.generation}')
# What `cmctl renew` does: mark the certificate as being issued.
k patch certificate app-mixer-data-plane-tls --subresource=status --type=json -p "[{\"op\":\"add\",\"path\":\"/status/conditions/-\",\"value\":{\"type\":\"Issuing\",\"status\":\"True\",\"reason\":\"ManuallyTriggered\",\"message\":\"Re-issuance triggered by the rotation test\",\"lastTransitionTime\":\"$now\",\"observedGeneration\":$gen}}]"
for i in $(seq 1 60); do [ "$(revision)" -gt "$rev" ] && break; sleep 2; done
[ "$(revision)" -gt "$rev" ] || fail "cert-manager did not reissue the certificate"
wait_ready
for pod in $pods; do cp "$work/$pod.serial" "$work/$pod.old-serial"; cp "$work/$pod.key" "$work/$pod.old-key"; done
wait_new_certificates
for pod in $pods; do
  verifies "$pod" "$work/ca1.pem" || fail "$pod's renewed certificate does not verify"
  [ "$(keyid "$pod")" != "$(cat "$work/$pod.old-key")" ] || fail "$pod kept the old key"
  [ "$(k get pod "$pod" -o jsonpath='{.metadata.uid} {.status.containerStatuses[0].restartCount}')" = "$(cat "$work/$pod.before")" ] || fail "$pod was restarted or replaced"
  k logs "$pod" | grep -q "TLS credentials active" || fail "$pod did not log a credential reload"
  echo "$pod: $(cat "$work/$pod.old-serial") -> $(cat "$work/$pod.serial"), new key, same container, no restart"
done

echo "== 3. CA rotation"
cat <<YAML | k apply -f -
apiVersion: cert-manager.io/v1
kind: Certificate
metadata: {name: app-mixer-ca-2}
spec:
  isCA: true
  commonName: app-mixer-ca-2
  secretName: app-mixer-ca-2
  duration: 87600h
  privateKey: {algorithm: ECDSA, size: 256}
  issuerRef: {name: app-mixer-selfsigned, kind: Issuer}
---
apiVersion: cert-manager.io/v1
kind: Issuer
metadata: {name: app-mixer-ca-2}
spec:
  ca: {secretName: app-mixer-ca-2}
YAML
k wait --for=condition=Ready certificate/app-mixer-ca-2 --timeout=120s
ca app-mixer-ca-2 > "$work/ca2.pem"
cat "$work/ca1.pem" "$work/ca2.pem" > "$work/bundle.pem"
# Clients get the bundle first: it verifies the current leaf, which still comes from the old CA.
for pod in $pods; do verifies "$pod" "$work/bundle.pem" || fail "the CA bundle does not verify $pod before the switch"; verifies "$pod" "$work/ca2.pem" && fail "the new CA verified a leaf it did not sign"; done
rev=$(revision)
k patch certificate app-mixer-data-plane-tls --type=merge -p '{"spec":{"issuerRef":{"name":"app-mixer-ca-2"}}}'
for i in $(seq 1 60); do [ "$(revision)" -gt "$rev" ] && break; sleep 2; done
[ "$(revision)" -gt "$rev" ] || fail "changing the issuer did not reissue the certificate"
wait_ready
wait_new_certificates
for pod in $pods; do
  verifies "$pod" "$work/bundle.pem" || fail "a client with both CAs stopped verifying $pod"
  verifies "$pod" "$work/ca2.pem" || fail "a client with only the new CA does not verify $pod"
  if verifies "$pod" "$work/ca1.pem"; then fail "a client with only the old CA still verifies $pod"; fi
  [ "$(k get pod "$pod" -o jsonpath='{.metadata.uid} {.status.containerStatuses[0].restartCount}')" = "$(cat "$work/$pod.before")" ] || fail "$pod was restarted or replaced"
  echo "$pod: bundle and new CA verify, old CA alone is refused; no restart"
done
echo "OK: cert-manager issued, renewed and rotated the Data Plane certificate without a restart"
