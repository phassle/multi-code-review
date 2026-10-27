# Build context: analyzers/
FROM python:3.12.15-alpine3.24
ARG RUFF_VERSION=0.17.0
ARG BANDIT_VERSION=1.9.4
RUN apk add --no-cache nodejs \
 && pip install --no-cache-dir "ruff==${RUFF_VERSION}" "bandit==${BANDIT_VERSION}"
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY python/adapter.mjs ./python/
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1 RUFF_NO_CACHE=true
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/python/adapter.mjs"]
