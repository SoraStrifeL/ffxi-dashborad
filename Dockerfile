FROM node:22-alpine AS builder
WORKDIR /app

# Install backend deps
COPY package*.json ./
RUN npm ci

# Install & build React client
COPY client/package*.json ./client/
RUN npm ci --prefix client

COPY . .
RUN npm run build                    # compile TypeScript backend → dist/
RUN npm run build --prefix client    # Vite React build → public/

FROM node:22-alpine
WORKDIR /app
# Build metadata for /api/version (passed via docker compose build args).
ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_DATE=$BUILD_DATE
# su-exec: drop from root to the unprivileged `node` user in the entrypoint
RUN apk add --no-cache su-exec
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist       ./dist
COPY --from=builder /app/public     ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
