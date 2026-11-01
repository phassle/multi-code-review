# Build context: analyzers/
# actionlint and shellcheck are static binaries, copied from their official
# multi-arch images (amd64, arm64). shellcheck is pinned on its own: the
# actionlint image bundles whatever shellcheck was "stable" at its build.
FROM rhysd/actionlint:1.7.12 AS actionlint
FROM koalaman/shellcheck-alpine:v0.11.0 AS shellcheck

FROM node:24-alpine
COPY --from=actionlint /usr/local/bin/actionlint /usr/local/bin/actionlint
COPY --from=shellcheck /bin/shellcheck /usr/local/bin/shellcheck
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY actionlint/adapter.mjs ./actionlint/
ENV HOME=/tmp
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/actionlint/adapter.mjs"]
