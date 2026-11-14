FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@0.160.0 && npm cache clean --force
WORKDIR /app
COPY writer/service.js /app/service.js
COPY writer/community-service.js /app/community-service.js
COPY writer/priority-gate.js /app/priority-gate.js
COPY src/code-nodes/core.js src/code-nodes/evidence.js src/code-nodes/community.js /src/code-nodes/
COPY schemas/writer-output.schema.json /app/writer-output.schema.json
RUN mkdir -p /data/.codex && chown -R node:node /data
USER node
ENV CODEX_HOME=/data/.codex
EXPOSE 8081
CMD ["node", "/app/service.js"]
