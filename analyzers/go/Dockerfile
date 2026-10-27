# Build context: analyzers/
FROM golang:1.27.2-alpine3.23 AS lint
ARG GOLANGCI_LINT_VERSION=2.14.0
ARG TARGETARCH
SHELL ["/bin/ash", "-eo", "pipefail", "-c"]
RUN apk add --no-cache curl \
 && curl -fsSL "https://github.com/golangci/golangci-lint/releases/download/v${GOLANGCI_LINT_VERSION}/golangci-lint-${GOLANGCI_LINT_VERSION}-linux-${TARGETARCH}.tar.gz" \
  | tar -xz -C /tmp \
 && mv /tmp/golangci-lint-${GOLANGCI_LINT_VERSION}-linux-${TARGETARCH}/golangci-lint /golangci-lint

FROM golang:1.27.2-alpine3.23
RUN apk add --no-cache nodejs
COPY --from=lint /golangci-lint /usr/local/bin/golangci-lint
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY go/adapter.mjs ./go/
# Run time has no network: modules come from the host's module cache
# (MCR_GOMODCACHE, mounted read-only) or the repo's vendor/ directory.
ENV HOME=/tmp GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local GOWORK=off CGO_ENABLED=0 \
    GOCACHE=/tmp/gocache GOLANGCI_LINT_CACHE=/tmp/lintcache GOTELEMETRY=off
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/go/adapter.mjs"]
