# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
# Bind to all interfaces so `-p 8787:8787` port mapping reaches the process
# (the default host is 127.0.0.1, which is unreachable from outside a container).
ENV OPENCODE_HOST=0.0.0.0
WORKDIR /app
# Copy the lockfile so `npm ci` can do a reproducible production install.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8787
USER node
CMD ["node", "dist/index.js"]
