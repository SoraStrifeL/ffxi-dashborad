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
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist       ./dist
COPY --from=builder /app/public     ./public
EXPOSE 3000
CMD ["node", "dist/server.js"]
