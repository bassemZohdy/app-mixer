# Product requirements baseline

- Fully open source, vendor-independent and developer-owned generated source.
- **Greenfield only:** CLI scaffolds new projects; existing-app retrofit is excluded.
- Conversation plus conventional persistent pages in a universal application shell.
- Frontend choices targeted: Angular, React, React Native and Flutter; parity requires validation.
- Development Mode and Runtime Mode have isolated authority. Control Plane optional, Data Plane standalone.
- Development Agent produces typed version-aware draft patches. Validate, preview, approve, publish immutable versions and support rollback.
- OpenAPI-first backend discovery; registered operations shared by UI and agents, subject to server authorization.
- Persistent application manifest independent of transient UI/chat/business state; A2UI for UI and AG-UI for events.
- Pluggable LLM providers, storage, components, identity and integrations.
- Internal data store optional; support explicit staged submissions and policy-driven offline synchronization.
- Two-level client/server published-definition cache and LLM-outage resilience.
- Docker Compose development, optional Kubernetes production, cloud-native observability.
- Plugin scopes: platform, development and application. No arbitrary agent-generated code execution.

**The current bootstrap only implements typed in-memory drafts/publishing and a minimal scaffold.** All other capabilities are future milestones.
