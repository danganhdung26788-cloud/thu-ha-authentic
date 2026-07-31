FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM dependencies AS build
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY migrations ./migrations
RUN npm run check && npm run test && npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 agentv2 \
  && useradd --system --uid 10001 --gid agentv2 --home /app agentv2
COPY --from=build --chown=agentv2:agentv2 /app/node_modules ./node_modules
COPY --from=build --chown=agentv2:agentv2 /app/dist ./dist
COPY --from=build --chown=agentv2:agentv2 /app/migrations ./migrations
COPY --from=build --chown=agentv2:agentv2 /app/package.json ./package.json
USER agentv2
EXPOSE 3100
CMD ["node", "dist/src/apps/api/main.js"]
