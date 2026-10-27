# Build context: analyzers/
FROM alpine:3.22 AS rules
ARG SEMGREP_RULES_SHA=9bbf021d0acffa3095fcffd17b2bc7787eb4796d
SHELL ["/bin/ash", "-eo", "pipefail", "-c"]
RUN apk add --no-cache git \
 && git init -q /src \
 && git -C /src remote add origin https://github.com/semgrep/semgrep-rules \
 && git -C /src fetch -q --depth 1 origin "$SEMGREP_RULES_SHA" && git -C /src checkout -q FETCH_HEAD
# Rule files for the languages we review, split by category on their path in
# semgrep-rules (…/security/…, …/correctness/…, …/performance/…). One container
# per category loads only its own folder. Test targets and fixtures are dropped.
WORKDIR /src
RUN for d in typescript javascript python go java kotlin scala csharp ruby php rust c swift dockerfile yaml bash; do \
      test -d "$d" || continue; find "$d" -type f \( -name "*.yaml" -o -name "*.yml" \) \
        ! -name "*.test.yaml" ! -name "*.test.yml" ! -name "*.fixed.*"; done \
 | while read -r f; do \
      case "/$f" in \
        */security/*|*/audit/*) c=security ;; \
        */correctness/*) c=correctness ;; \
        */performance/*) c=reliability ;; \
        *) c=best-practices ;; \
      esac; \
      mkdir -p "/rules/$c/$(dirname "$f")" && cp "$f" "/rules/$c/$f"; \
    done \
 && cp LICENSE /rules/LICENSE

# Our own rules (rules/<category>/…), tested at build time: each rule file has a
# target next to it with ruleid/ok annotations. Served as /rules/<category>/mcr/…,
# so their ids read mcr.<path>.<rule>.
FROM semgrep/semgrep:1.179.0 AS mcr-rules
COPY semgrep/rules /mcr
WORKDIR /mcr
RUN semgrep --test --metrics=off --disable-version-check . \
 && for c in */; do mkdir -p "/out/$c" && cp -r "$c" "/out/${c}mcr"; done \
 && find /out -type f ! -name '*.yaml' -delete

FROM semgrep/semgrep:1.179.0
RUN apk add --no-cache nodejs
COPY --from=rules /rules /rules
COPY --from=mcr-rules /out /rules
WORKDIR /opt/mcr
COPY _kit/serve.mjs ./_kit/
COPY semgrep/adapter.mjs ./semgrep/
ENV SEMGREP_RULES=/rules SEMGREP_SEND_METRICS=off SEMGREP_ENABLE_VERSION_CHECK=0 HOME=/tmp
USER 1000
EXPOSE 8080
ENTRYPOINT ["node", "/opt/mcr/semgrep/adapter.mjs"]
