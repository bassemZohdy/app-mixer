# Local Docker Compose profile

This single-user development profile starts the generated `demo-app` workspace, a Data Plane, a Control Plane and a deterministic demonstration agent. Docker Engine and the Compose plugin are required. Generate two distinct random tokens and keep them private:

```sh
export CONTROL_TOKEN="$(openssl rand -hex 32)"
export AGENT_TOKEN="$(openssl rand -hex 32)"
docker compose up --build -d
```

Open `http://127.0.0.1:3000`. The Control Plane API is at `http://127.0.0.1:3001` and requires the Control token as a bearer credential; see [plane APIs](plane-apis.md). `docker compose stop agent` simulates an agent outage: chat fails but the published workspace remains available. Restart it with `docker compose start agent`.

Definitions are stored in the `definitions` named volume. The init service publishes the starter definition only when no publication exists; subsequent starts preserve the draft and published history. `docker compose down` stops and removes the containers without removing the volume. Removing the volume deletes the local definitions.

The Data Plane enables `/health/live` and `/health/ready` on its internal loopback listener. To enable process-local metrics, set `DATA_METRICS_TOKEN` to a private random value of at least 32 characters before starting Compose. The separate metrics listener is available only inside the shared container network namespace and requires that bearer token. For example:

```sh
export DATA_METRICS_TOKEN="$(openssl rand -hex 32)"
docker compose up -d
docker compose exec data node -e "fetch('http://127.0.0.1:3004/metrics',{headers:{authorization:'Bearer '+process.env.DATA_METRICS_TOKEN}}).then(async r=>console.log(await r.text()))"
```

When running the local service directly, set `DATA_HEALTH_ENABLED=true` to enable health checks and optionally set `DATA_METRICS_TOKEN` and `DATA_METRICS_PORT` (default 3004). Metrics are disabled when the token is empty or absent. Set `DATA_DRAIN_DELAY_MS` (0–30,000, default 0) to make the Data Plane report unavailable readiness for that interval before closing on shutdown; a nonzero delay requires health probes. The listener is loopback-only and its development token is not a replacement for production identity or transport security.

The host ports are bound to loopback. The services share the workspace container's network namespace so the unauthenticated Data Plane and demonstration agent remain on loopback inside the container network. The workspace and token-protected Control Plane must bind to the container interface for Docker port forwarding; other containers with network access to that interface may reach them. Use this profile only on a trusted local Docker host and network. The tokens are shared-secret development guards, not production identity or tenant isolation. The agent is a fixed-response demo, not a configured LLM. A published page renders only supported Text components. This is not a production deployment.

The Compose smoke test in CI builds the image, exercises publish and agent and Control Plane outages, checks health and protected metrics, verifies persistence after a Data Plane restart, and removes its own temporary Compose project and volume. Existing user volumes are not targeted.
