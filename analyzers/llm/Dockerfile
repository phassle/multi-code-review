# Build context: analyzers/
FROM node:24-alpine
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY llm/adapter.mjs ./llm/
ENV HOME=/tmp NODE_ENV=production
USER node
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/llm/adapter.mjs"]
