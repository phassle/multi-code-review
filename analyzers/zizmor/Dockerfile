# syntax=docker/dockerfile:1.7
# Build context: analyzers/
# zizmor's Linux release binaries link glibc, so the runtime is Debian slim
# with only the node binary from node:24 (no npm).
FROM node:24-bookworm-slim AS fetch
ARG ZIZMOR_VERSION=1.31.1
ARG TARGETARCH
ADD --checksum=sha256:d185f726bdaf92df78273217dfdd24ebcd6b0ef48cf3ce776ff5762b6e138c99 \
    https://github.com/zizmorcore/zizmor/releases/download/v${ZIZMOR_VERSION}/zizmor-x86_64-unknown-linux-gnu.tar.gz /dl/amd64.tar.gz
ADD --checksum=sha256:37eebbd5762a44f262d94875431b14a6d2402991e90a685113ea97b8b41be833 \
    https://github.com/zizmorcore/zizmor/releases/download/v${ZIZMOR_VERSION}/zizmor-aarch64-unknown-linux-gnu.tar.gz /dl/arm64.tar.gz
RUN tar -xzf /dl/${TARGETARCH}.tar.gz -C /usr/local/bin zizmor && zizmor --version

FROM debian:bookworm-slim
COPY --from=fetch /usr/local/bin/node /usr/local/bin/zizmor /usr/local/bin/
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY zizmor/adapter.mjs ./zizmor/
# Offline: no GitHub API, no token.
ENV HOME=/tmp ZIZMOR_OFFLINE=true
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/zizmor/adapter.mjs"]
