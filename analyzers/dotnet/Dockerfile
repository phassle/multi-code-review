# Build context: analyzers/
# The SDK band should match the one that ran `dotnet restore` on the host
# (targeting packs are resolved by version from the mounted NuGet folder).
ARG DOTNET_SDK=10.0.302-alpine3.24
FROM mcr.microsoft.com/dotnet/sdk:${DOTNET_SDK}
RUN apk add --no-cache nodejs
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY dotnet/adapter.mjs dotnet/mcr.props ./dotnet/
ENV HOME=/tmp DOTNET_CLI_HOME=/tmp DOTNET_NOLOGO=1 DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 DOTNET_GENERATE_ASPNET_CERTIFICATE=false \
    DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE=1 DOTNET_ADD_GLOBAL_TOOLS_TO_PATH=false \
    MSBUILDDISABLENODEREUSE=1 NUGET_PACKAGES=/nuget/packages
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/dotnet/adapter.mjs"]
