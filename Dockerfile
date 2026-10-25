FROM node:24-alpine3.21

WORKDIR /usr/src/app

# Install from the lockfile for reproducible builds (dev deps are needed to compile).
COPY --chown=node:node package*.json ./
RUN npm ci --no-audit --no-fund

COPY --chown=node:node . .
RUN npm run build && npm prune --omit=dev \
    && mkdir -p /usr/src/app/data/media && chown -R node:node /usr/src/app

USER node

ENV PORT=5109
ENV WHATSAPP_MEDIA_DIR=/usr/src/app/data/media
EXPOSE 5109

# Received media lives here; mount a volume so it survives redeploys.
VOLUME ["/usr/src/app/data/media"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:5109/api/whatsapp/health || exit 1

CMD ["node", "./build/src/app.js"]
