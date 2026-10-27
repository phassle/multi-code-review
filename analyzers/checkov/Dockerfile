# Build context: analyzers/
FROM node:24-bookworm-slim AS node

FROM python:3.12-slim-bookworm
ARG CHECKOV_VERSION=3.3.29
RUN pip install --no-cache-dir "checkov==${CHECKOV_VERSION}"
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY checkov/checks.py checkov/adapter.mjs ./checkov/
RUN python checkov/checks.py checkov/checks.json && rm checkov/checks.py
# Offline: no Prisma Cloud API, no module downloads, no version check.
ENV HOME=/tmp BC_SKIP_MAPPING=TRUE CHECKOV_RUN_SCA_PACKAGE_SCAN_V2=FALSE PYTHONDONTWRITEBYTECODE=1
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/checkov/adapter.mjs"]
