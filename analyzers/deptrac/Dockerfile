# Build context: analyzers/
# deptrac has no phar release; composer (pinned phar, checksummed) installs the
# pinned deptrac/deptrac package in a builder stage. Only its vendor dir ships.
# deptrac's own dependencies are resolved at build time within its constraints
# (no lock file here), so a rebuild may pick newer patch releases.
FROM php:8.3.36-cli-alpine3.24 AS deptrac
ARG COMPOSER_VERSION=2.11.1
ARG DEPTRAC_VERSION=4.7.2
ADD --checksum=sha256:6f1b891e1d4927d62740276c540fb490e47689e19e102c49e8da849794882f8c \
    https://getcomposer.org/download/${COMPOSER_VERSION}/composer.phar /usr/local/bin/composer.phar
WORKDIR /opt/deptrac
RUN COMPOSER_HOME=/tmp/composer COMPOSER_CACHE_DIR=/dev/null php /usr/local/bin/composer.phar require --no-interaction --no-progress \
      --prefer-dist --optimize-autoloader --update-no-dev "deptrac/deptrac:${DEPTRAC_VERSION}" \
 && rm -f composer.json composer.lock

FROM php:8.3.36-cli-alpine3.24
RUN apk add --no-cache "nodejs~=24"
COPY --from=deptrac /opt/deptrac /opt/deptrac
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY deptrac/adapter.mjs ./deptrac/
ENV HOME=/tmp TMPDIR=/tmp
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/deptrac/adapter.mjs"]
