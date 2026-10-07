# ViaRoute media agent — build from this folder:  docker build -t viaroute-media-agent apps/media-agent
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-save --no-audit --no-fund typescript@5.9.3 @types/node@22
COPY src ./src
COPY test ./test
RUN npx tsc -p tsconfig.json

FROM node:22-alpine
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/dist ./dist
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/src/main.js"]
