# Build context: analyzers/
# No tool binary: it only reads coverage reports the repo's test run wrote, so Node is all it needs.
FROM node:24-alpine
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY coverage/adapter.mjs ./coverage/
ENV HOME=/tmp
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/coverage/adapter.mjs"]
