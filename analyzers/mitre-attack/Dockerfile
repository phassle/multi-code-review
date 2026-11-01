# Build context: analyzers/
# No tool binary: the rules are plain JavaScript in adapter.mjs.
FROM alpine:3.22
RUN apk add --no-cache nodejs
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY mitre-attack/adapter.mjs ./mitre-attack/
ENV HOME=/tmp
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/mitre-attack/adapter.mjs"]
