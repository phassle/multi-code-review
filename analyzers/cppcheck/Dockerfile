# Build context: analyzers/
FROM alpine:3.22
ARG CPPCHECK_VERSION=2.14.2-r1
RUN apk add --no-cache "cppcheck=${CPPCHECK_VERSION}" nodejs
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY cppcheck/adapter.mjs ./cppcheck/
ENV HOME=/tmp
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/cppcheck/adapter.mjs"]
