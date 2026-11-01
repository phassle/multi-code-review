# Build context: analyzers/
# go-arch-lint checks imports from the AST alone, but its deep scan (on by
# default in arch files v3) loads typed packages through the go command, so the
# image carries the Go toolchain, as analyzers/go does.
FROM golang:1.27.2-alpine3.23 AS tool
ARG GO_ARCH_LINT_VERSION=1.19.0
ARG TARGETARCH
ADD --checksum=sha256:b4454546abf95ab1b32c26af146bc7c73ba3856c534d66890ac0738bada5a03c \
    https://github.com/fe3dback/go-arch-lint/releases/download/v${GO_ARCH_LINT_VERSION}/go-arch-lint_${GO_ARCH_LINT_VERSION}_linux_amd64.tar.gz /dl/amd64.tar.gz
ADD --checksum=sha256:50174a73916c767eda2b27cf18a4db80cd7f102eeb4c514a705239279fd2754b \
    https://github.com/fe3dback/go-arch-lint/releases/download/v${GO_ARCH_LINT_VERSION}/go-arch-lint_${GO_ARCH_LINT_VERSION}_linux_arm64.tar.gz /dl/arm64.tar.gz
RUN mkdir /out && tar -xzf "/dl/${TARGETARCH}.tar.gz" -C /out go-arch-lint

FROM golang:1.27.2-alpine3.23
RUN apk add --no-cache "nodejs~=24"
COPY --from=tool /out/go-arch-lint /usr/local/bin/go-arch-lint
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY go-arch-lint/adapter.mjs ./go-arch-lint/
# Run time has no network: modules come from the host's module cache
# (MCR_GOMODCACHE, mounted read-only) or the repo's vendor/ directory.
ENV HOME=/tmp GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local GOWORK=off CGO_ENABLED=0 \
    GOCACHE=/tmp/gocache GOTELEMETRY=off
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/go-arch-lint/adapter.mjs"]
