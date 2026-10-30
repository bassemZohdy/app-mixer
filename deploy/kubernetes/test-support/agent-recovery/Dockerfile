FROM node:22.13.0-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22.13.0-bookworm-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/agent/package.json ./packages/agent/package.json
COPY --from=build /app/packages/agent/dist ./packages/agent/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/web/package.json ./packages/web/package.json
COPY --from=build /app/packages/web/dist ./packages/web/dist
COPY deploy/kubernetes/test-support/agent-recovery/recovery.mjs ./deploy/kubernetes/test-support/agent-recovery/recovery.mjs
CMD ["node", "deploy/kubernetes/test-support/agent-recovery/recovery.mjs", "idle"]
