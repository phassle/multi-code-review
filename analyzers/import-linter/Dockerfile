# Build context: analyzers/
# import-linter (lint-imports) checks a repo's own import contracts. Its
# graph builder grimp parses imports statically and never runs repo code.
FROM python:3.12.15-alpine3.24
ARG IMPORT_LINTER_VERSION=2.15
ARG GRIMP_VERSION=3.18
RUN apk add --no-cache nodejs=24.22.1-r1 \
 && pip install --no-cache-dir "import-linter==${IMPORT_LINTER_VERSION}" "grimp==${GRIMP_VERSION}"
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY import-linter/adapter.mjs ./import-linter/
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/import-linter/adapter.mjs"]
