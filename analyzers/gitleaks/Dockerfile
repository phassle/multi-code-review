# Build context: analyzers/
FROM zricethezav/gitleaks:v8.28.0 AS gitleaks

FROM alpine:3.22
RUN apk add --no-cache nodejs
COPY --from=gitleaks /usr/bin/gitleaks /usr/local/bin/gitleaks
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY gitleaks/adapter.mjs ./gitleaks/
ENV HOME=/tmp
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/gitleaks/adapter.mjs"]
