# Build context: analyzers/
# knip parses with oxc (native binary, musl build on alpine), so no TypeScript
# peer is needed.
FROM node:24-alpine
RUN npm install --global --no-fund --no-audit knip@6.42.1 \
 && npm cache clean --force
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY knip/adapter.mjs ./knip/
ENV HOME=/tmp NODE_ENV=production
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/knip/adapter.mjs"]
