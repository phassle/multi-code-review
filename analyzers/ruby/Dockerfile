# Build context: analyzers/
FROM ruby:3.3.12-alpine3.23
ARG RUBOCOP_VERSION=1.92.0
ARG RUBOCOP_RAILS_VERSION=2.38.0
ARG RUBOCOP_RSPEC_VERSION=3.10.2
ARG RUBOCOP_PERFORMANCE_VERSION=1.27.0
ARG BRAKEMAN_VERSION=8.1.0
RUN apk add --no-cache nodejs \
 && apk add --no-cache --virtual .build build-base \
 && gem install --no-document \
      "rubocop:${RUBOCOP_VERSION}" \
      "rubocop-rails:${RUBOCOP_RAILS_VERSION}" \
      "rubocop-rspec:${RUBOCOP_RSPEC_VERSION}" \
      "rubocop-performance:${RUBOCOP_PERFORMANCE_VERSION}" \
      "brakeman:${BRAKEMAN_VERSION}" \
 && apk del .build && rm -rf /root/.gem /usr/local/bundle/cache
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY ruby/adapter.mjs ruby/default.rubocop.yml ./ruby/
ENV HOME=/tmp
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/ruby/adapter.mjs"]
