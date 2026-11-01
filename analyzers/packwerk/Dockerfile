# syntax=docker/dockerfile:1.7
# Build context: analyzers/
# pks (the static Rust port of packwerk) publishes only macOS binaries, so it
# is built from the pinned crates.io source (checksum-verified, Cargo.lock
# --locked) as a static musl binary, for amd64 and arm64 alike. The crate's
# rust-toolchain.toml asks for 1.81 plus macOS targets; the image's toolchain
# is used instead.
FROM rust:1.81-alpine3.20 AS build
ARG PKS_VERSION=0.2.40
ADD --checksum=sha256:c79a2e8f12c53934afad5cfe4414079f663fad58835cd9584626c33a12f0f53f \
    https://static.crates.io/crates/pks/pks-${PKS_VERSION}.crate /dl/pks.tar.gz
RUN apk add --no-cache musl-dev=1.2.5-r4
WORKDIR /src
RUN tar -xzf /dl/pks.tar.gz --strip-components=1 \
    && rm rust-toolchain.toml \
    && cargo build --release --locked --bin pks \
    && strip target/release/pks \
    && target/release/pks --version

FROM node:24-alpine3.22
COPY --from=build /src/target/release/pks /usr/local/bin/pks
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY packwerk/adapter.mjs ./packwerk/
ENV HOME=/tmp
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/packwerk/adapter.mjs"]
