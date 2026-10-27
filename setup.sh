#!/usr/bin/env bash
# One command: find out what the codebase is made of, start only the analyzers
# it needs, and check they answer. Needs only Docker.
#
#   ./setup.sh                 scan all of MCR_ROOT (default ~/Source)
#   ./setup.sh ~/Source/acme   scan just these (they must be under MCR_ROOT)
#   ./setup.sh --dry-run       report and .env, start nothing
#   ./setup.sh --offline       no code leaves the machine: no LLM reviewers, no Jev
#
# An LLM reviewer per category starts too when secrets/llm_api_key exists
# (any OpenAI-compatible API; set MCR_LLM_BASE_URL and MCR_LLM_MODEL in .env).
set -euo pipefail
cd "$(dirname "$0")"

DRY=0
OFFLINE=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --offline) OFFLINE=1 ;;
    *) ARGS+=("$(cd "$a" && pwd -P)") ;;
  esac
done

# Keep what the user set by hand in .env; setup owns only its own keys.
touch .env
# Only these are read back; profiles are recomputed every time.
from_env() { sed -n "s/^$1=//p" .env | tail -1; }
export MCR_ROOT="${MCR_ROOT:-$(from_env MCR_ROOT)}"
export MCR_ROOT="${MCR_ROOT:-$HOME/Source}"
export MCR_PORT="${MCR_PORT:-$(from_env MCR_PORT)}"
unset COMPOSE_PROFILES MCR_PROFILES MCR_JEV

echo "▸ Building the gateway image…" >&2
docker compose build -q review-mcp

echo "▸ Scanning ${ARGS[*]:-$MCR_ROOT}…" >&2
detected=$(docker compose run --rm --no-deps -T review-mcp node src/setup.ts ${ARGS[@]+"${ARGS[@]}"})
profiles=$(sed -n 's/^COMPOSE_PROFILES=//p' <<<"$detected")

if [ "$OFFLINE" = 1 ]; then
  echo "▸ Offline: no LLM reviewers and no Jev; no code leaves the machine." >&2
elif [ -s secrets/llm_api_key ]; then
  profiles="${profiles:+$profiles,}llm"
  echo "▸ LLM reviewers on: ${MCR_LLM_MODEL:-glm-5.3-flash} at ${MCR_LLM_BASE_URL:-https://api.grunden.ai/v1}" >&2
else
  echo "▸ No secrets/llm_api_key: the harness model reviews what the analyzers cannot." >&2
fi

grep -vE '^(COMPOSE_PROFILES|MCR_PROFILES|MCR_ROOT|MCR_JEV)=' .env > .env.tmp || true
{
  cat .env.tmp
  echo "MCR_ROOT=$MCR_ROOT"
  echo "COMPOSE_PROFILES=$profiles"
  echo "MCR_PROFILES=$profiles"
  if [ "$OFFLINE" = 1 ]; then echo "MCR_JEV=off"; fi
} > .env
rm -f .env.tmp
# The shell environment beats .env in compose: export what was just written.
export COMPOSE_PROFILES="$profiles" MCR_PROFILES="$profiles"
if [ "$OFFLINE" = 1 ]; then export MCR_JEV=off; fi
shown="$profiles"; [ -n "$shown" ] || shown='(core only)'
echo "▸ Wrote .env: COMPOSE_PROFILES=$shown" >&2

[ "$DRY" = 1 ] && exit 0

# Secrets are files; compose needs the file to exist even when llm is off.
mkdir -p secrets && touch secrets/llm_api_key secrets/typesafe_api_key && chmod 600 secrets/*
if [ "$OFFLINE" = 0 ] && [ -s secrets/typesafe_api_key ]; then echo "▸ Jev (TypeSafe) judges findings and risk tier." >&2; fi

echo "▸ Starting analyzers…" >&2
docker compose up -d --build --remove-orphans

port="${MCR_PORT:-7700}"
for _ in $(seq 1 60); do
  if health=$(curl -fsS "http://127.0.0.1:$port/healthz" 2>/dev/null); then
    echo "✔ Ready: http://127.0.0.1:$port/mcp" >&2
    echo "  $health" >&2
    exit 0
  fi
  sleep 1
done
echo "✖ The gateway did not answer on :$port; see: docker compose logs review-mcp" >&2
exit 1
