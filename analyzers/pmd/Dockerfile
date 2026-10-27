# Build context: analyzers/
FROM alpine:3.22 AS pmd
ARG PMD_VERSION=7.28.0
RUN apk add --no-cache curl unzip \
 && curl -fsSL -o /pmd.zip "https://github.com/pmd/pmd/releases/download/pmd_releases/${PMD_VERSION}/pmd-dist-${PMD_VERSION}-bin.zip" \
 && unzip -q /pmd.zip -d / && mv /pmd-bin-${PMD_VERSION} /pmd

FROM eclipse-temurin:21-jre-alpine
RUN apk add --no-cache nodejs
COPY --from=pmd /pmd /opt/pmd
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY pmd/adapter.mjs ./pmd/
ENV PATH=/opt/pmd/bin:$PATH HOME=/tmp JAVA_TOOL_OPTIONS="-Xmx1g -XX:+UseSerialGC -Djava.io.tmpdir=/tmp"
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/pmd/adapter.mjs"]
