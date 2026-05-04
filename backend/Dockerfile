# syntax=docker/dockerfile:1.7

# ---- builder ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# LibreOffice (writer only) for DOCX -> PDF, plus tini for signal handling.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       libreoffice-core \
       libreoffice-writer \
       fonts-liberation \
       tini \
  && rm -rf /var/lib/apt/lists/*

# Make sure the prebaked `node` user has a writable home for the LibreOffice profile.
RUN mkdir -p /home/node/.config && chown -R node:node /home/node

COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/package.json ./package.json

USER node
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
