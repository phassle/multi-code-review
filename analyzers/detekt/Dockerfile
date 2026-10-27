# Build context: analyzers/
FROM alpine:3.22 AS detekt
ARG DETEKT_VERSION=1.23.8
ARG DETEKT_SHA256=2ce2ff952e150baf28a29cda70a363b0340b3e81a55f43e51ec5edffc3d066c1
SHELL ["/bin/ash", "-eo", "pipefail", "-c"]
RUN apk add --no-cache curl \
 && curl -fsSL -o /detekt-cli.jar "https://github.com/detekt/detekt/releases/download/v${DETEKT_VERSION}/detekt-cli-${DETEKT_VERSION}-all.jar" \
 && echo "${DETEKT_SHA256}  /detekt-cli.jar" | sha256sum -c -

FROM eclipse-temurin:21-jre-alpine
RUN apk add --no-cache nodejs
COPY --from=detekt /detekt-cli.jar /opt/detekt/detekt-cli.jar
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY detekt/adapter.mjs detekt/defaults.yml ./detekt/
ENV DETEKT_JAR=/opt/detekt/detekt-cli.jar HOME=/tmp JAVA_TOOL_OPTIONS="-Xmx1g -XX:+UseSerialGC -Djava.io.tmpdir=/tmp"
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/detekt/adapter.mjs"]
