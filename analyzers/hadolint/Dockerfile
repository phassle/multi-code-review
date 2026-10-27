# Build context: analyzers/
FROM hadolint/hadolint:v2.14.0-alpine AS hadolint

FROM alpine:3.22
RUN apk add --no-cache nodejs
COPY --from=hadolint /bin/hadolint /usr/local/bin/hadolint
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY hadolint/adapter.mjs ./hadolint/
ENV HOME=/tmp
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/hadolint/adapter.mjs"]
