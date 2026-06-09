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
WORKDIR /app
COPY package.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8787
USER node
CMD ["node", "dist/index.js"]