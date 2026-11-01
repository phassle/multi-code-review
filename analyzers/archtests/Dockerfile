# Build context: analyzers/
# No tool binary: it only reads architecture test results (JUnit XML, TRX) the
# repo's own test run wrote, so Node is all it needs. It never runs repo code.
FROM node:24-alpine
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY archtests/adapter.mjs ./archtests/
ENV HOME=/tmp
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/archtests/adapter.mjs"]
