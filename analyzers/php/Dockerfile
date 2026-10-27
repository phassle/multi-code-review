# Build context: analyzers/
FROM alpine:3.22 AS phpstan
ARG PHPSTAN_VERSION=2.2.17
RUN apk add --no-cache curl \
 && curl -fsSL -o /phpstan.phar "https://github.com/phpstan/phpstan/releases/download/${PHPSTAN_VERSION}/phpstan.phar" \
 && chmod 0755 /phpstan.phar

FROM php:8.3-cli-alpine
RUN apk add --no-cache nodejs
COPY --from=phpstan /phpstan.phar /opt/phpstan/phpstan.phar
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY php/adapter.mjs ./php/
ENV HOME=/tmp TMPDIR=/tmp
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/php/adapter.mjs"]
