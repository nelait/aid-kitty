# syntax=docker/dockerfile:1
FROM node:22.23.4-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
RUN npm run build && npm prune --omit=dev

FROM node:22.23.4-bookworm-slim
ENV NODE_ENV=production \
    PORT=8787 \
    DEVHUB_DB=/data/devhub.db \
    DEVHUB_CONFIG=/etc/devhub/devhub.config.json
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY package.json ./
RUN mkdir -p /data /etc/devhub && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/src/server.js"]
