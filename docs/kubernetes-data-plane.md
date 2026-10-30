# Kubernetes Data Plane package

This package deploys a replicated, read-only Data Plane serving one pre-approved immutable publication. It is a component of the production deployment task, not a complete App Mixer production stack: it does not deploy the Control Plane, agent workers, shared data stores, identity, external TLS termination or publication-signature verification.

The image reads a single `{ "version": 1, "definition": { ... } }` publication from a mounted file at startup, validates the definition, and keeps a snapshot in memory. `/application` serves it, `/application/versions/:version` serves that version only, and other versions return 404. Replacing the ConfigMap triggers a rollout; no Control Plane connection is needed at runtime. The bundled publication is a demonstration only. A release pipeline must authenticate, authorize, validate and approve the exact publication and protect the deployment and ConfigMap from unauthorized changes. This package does not verify provenance, signatures, tenant access, or release freshness, and rollback of the deployment can serve an older publication.

Build and push `Dockerfile.data-plane` to a trusted registry, pin both base images and the deployment image by approved digest, and use an environment-specific Kustomize overlay to replace the sample publication and image. For a local cluster smoke test only:

```sh
docker build -f Dockerfile.data-plane -t app-mixer-data-plane:test .
kind load docker-image app-mixer-data-plane:test
kubectl apply -n YOUR_NAMESPACE -k deploy/kubernetes/data-plane
kubectl rollout status -n YOUR_NAMESPACE deployment/app-mixer-data-plane
```

The base uses two replicas, a rolling update with zero unavailable replicas, liveness/readiness/startup probes, a disruption budget, resource limits, preferred node spreading, a non-root user, read-only root filesystem, dropped capabilities, runtime-default seccomp, and no service-account token. On SIGTERM the server fails readiness, serves for five seconds, then stops accepting connections; the 30-second termination grace period must be tuned for the ingress, workload and cluster. The disruption budget covers voluntary evictions and does not ensure availability during node failure; use multiple failure domains and test your scheduler, capacity and rollout strategy.

The internal ClusterIP server is unauthenticated HTTP. The sample NetworkPolicy allows ingress only from labeled pods in the same namespace and denies egress, but policies require a CNI that enforces them; node-origin probes and service routing vary by platform. Pod labels are not authentication. Restrict who can create or relabel pods, configure namespace isolation, and place a trusted authenticated TLS gateway or service mesh in front of the service before exposing it. Verify all network rules and certificate/identity lifecycle on the target cluster. Only publish data all permitted clients may read; do not put credentials or private data into ConfigMaps. Define limits, monitoring, availability targets, backup and release controls appropriate to the environment.

CI builds the image, starts a disposable kind cluster, tests two-replica readiness, a new publication rollout, and pod replacement. Kind's default network implementation does not validate NetworkPolicy enforcement, and the test does not prove production security, multi-node availability, disaster recovery, release authorization or production load capacity. Old generated ConfigMaps are not automatically removed; use an authorized retention process after confirming no workload needs them.
