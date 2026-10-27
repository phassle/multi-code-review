# Build context: analyzers/
FROM node:24-slim
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY ts/adapter.mjs ./ts/
ENV HOME=/tmp NODE_ENV=production
USER node
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/ts/adapter.mjs"]
