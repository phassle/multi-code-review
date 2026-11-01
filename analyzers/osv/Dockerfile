# Build context: analyzers/
# The OSV database is downloaded here, at build; the container never goes
# online. ADD re-checks the URLs on every build (refreshes when OSV changed)
# and keeps each zip's Last-Modified as its mtime, which info.version reports.
FROM ghcr.io/google/osv-scanner:v2.7.0 AS osv

FROM node:24-alpine
COPY --from=osv /osv-scanner /usr/local/bin/osv-scanner
ENV OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY=/opt/osv-db
ADD --chmod=755 https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip /opt/osv-db/osv-scalibr/npm/all.zip
ADD --chmod=755 https://osv-vulnerabilities.storage.googleapis.com/PyPI/all.zip /opt/osv-db/osv-scalibr/PyPI/all.zip
ADD --chmod=755 https://osv-vulnerabilities.storage.googleapis.com/Go/all.zip /opt/osv-db/osv-scalibr/Go/all.zip
ADD --chmod=755 https://osv-vulnerabilities.storage.googleapis.com/crates.io/all.zip /opt/osv-db/osv-scalibr/crates.io/all.zip
ADD --chmod=755 https://osv-vulnerabilities.storage.googleapis.com/RubyGems/all.zip /opt/osv-db/osv-scalibr/RubyGems/all.zip
ADD --chmod=755 https://osv-vulnerabilities.storage.googleapis.com/Packagist/all.zip /opt/osv-db/osv-scalibr/Packagist/all.zip
ADD --chmod=755 https://osv-vulnerabilities.storage.googleapis.com/NuGet/all.zip /opt/osv-db/osv-scalibr/NuGet/all.zip
ADD --chmod=755 https://osv-vulnerabilities.storage.googleapis.com/Maven/all.zip /opt/osv-db/osv-scalibr/Maven/all.zip
ADD --chmod=755 https://osv-vulnerabilities.storage.googleapis.com/Pub/all.zip /opt/osv-db/osv-scalibr/Pub/all.zip
ADD --chmod=755 https://osv-vulnerabilities.storage.googleapis.com/Hex/all.zip /opt/osv-db/osv-scalibr/Hex/all.zip
ADD --chmod=755 https://osv-vulnerabilities.storage.googleapis.com/SwiftURL/all.zip /opt/osv-db/osv-scalibr/SwiftURL/all.zip
ADD --chmod=755 https://osv-vulnerabilities.storage.googleapis.com/CRAN/all.zip /opt/osv-db/osv-scalibr/CRAN/all.zip
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY osv/adapter.mjs ./osv/
ENV HOME=/tmp
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/osv/adapter.mjs"]
