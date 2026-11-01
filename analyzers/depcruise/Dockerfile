# Build context: analyzers/
# dependency-cruiser, plus TypeScript so it can parse .ts files and read
# tsconfig paths (it supports typescript <7, the JS compiler API).
FROM node:24-alpine
RUN npm install --global --no-fund --no-audit dependency-cruiser@18.7.0 typescript@6.0.3 \
 && npm cache clean --force
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY depcruise/adapter.mjs ./depcruise/
ENV HOME=/tmp NODE_ENV=production
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/depcruise/adapter.mjs"]
