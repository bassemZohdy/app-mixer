# Local Docker Compose profile

This single-user development profile starts the generated `demo-app` workspace, a Data Plane, a Control Plane and a deterministic demonstration agent. Docker Engine and the Compose plugin are required. Generate two distinct random tokens and keep them private:

```sh
export CONTROL_TOKEN="$(openssl rand -hex 32)"
export AGENT_TOKEN="$(openssl rand -hex 32)"
docker compose up --build -d
```

Open `http://127.0.0.1:3000`. The Control Plane API is at `http://127.0.0.1:3001` and requires the Control token as a bearer credential; see [plane APIs](plane-apis.md). `docker compose stop agent` simulates an agent outage: chat fails but the published workspace remains available. Restart it with `docker compose start agent`.

Definitions are stored in the `definitions` named volume. The init service publishes the starter definition only when no publication exists; subsequent starts preserve the draft and published history. `docker compose down` stops and removes the containers without removing the volume. Removing the volume deletes the local definitions.

The host ports are bound to loopback. The services share the workspace container's network namespace so the unauthenticated Data Plane and demonstration agent remain on loopback inside the container network. The workspace and token-protected Control Plane must bind to the container interface for Docker port forwarding; other containers with network access to that interface may reach them. Use this profile only on a trusted local Docker host and network. The tokens are shared-secret development guards, not production identity or tenant isolation. The agent is a fixed-response demo, not a configured LLM. A published page renders only supported Text components. This is not a production deployment.

The Compose smoke test in CI builds the image, exercises publish and agent outage, verifies persistence after a Data Plane restart, and removes its own temporary Compose project and volume. Existing user volumes are not targeted.
