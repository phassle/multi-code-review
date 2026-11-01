#!/usr/bin/env bash
# One command: find out what the codebase is made of, start only the analyzers
# it needs, and check they answer. Needs only Docker.
#
#   ./setup.sh                 first time: asks where the code is, which repos to
#                              size the stack for and which profiles to skip; saves
#                              the answers in .env and reuses them after that
#   ./setup.sh ~/Source/acme   scan just these (under MCR_ROOT); saved as the new choice
#   ./setup.sh --reconfigure   ask the first-time questions again
#   ./setup.sh --dry-run       report and .env, start nothing
#   ./setup.sh --offline       no code leaves the machine: no LLM reviewers, no Jev
#
# Saved in .env: MCR_ROOT, MCR_SCAN (repos, ':'-separated; empty = all of
# MCR_ROOT) and MCR_SKIP_PROFILES (profiles never started, e.g. dotnet,jvm).
# Without a terminal (CI, Aspire) it never asks; MCR_SETUP_INTERACTIVE=1 asks anyway
# and reads the answers from stdin.
#
# An LLM reviewer per category starts too when secrets/llm_api_key exists
# (any OpenAI-compatible API; set MCR_LLM_BASE_URL and MCR_LLM_MODEL in .env).
set -euo pipefail
cd "$(dirname "$0")"

DRY=0
OFFLINE=0
RECONFIGURE=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --offline) OFFLINE=1 ;;
    --reconfigure) RECONFIGURE=1 ;;
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
SCAN="$(from_env MCR_SCAN)"
SKIP="$(from_env MCR_SKIP_PROFILES)"

# Ask only with a person at a terminal, and only the first time (or when asked to).
# MCR_SETUP_INTERACTIVE=1 asks even without a terminal, reading the answers from stdin.
ASKING=0
if { { [ -t 0 ] && [ -t 2 ] && [ -z "${CI:-}" ]; } || [ "${MCR_SETUP_INTERACTIVE:-}" = 1 ]; } && [ ${#ARGS[@]} -eq 0 ]; then
  if [ "$RECONFIGURE" = 1 ] || ! grep -q '^MCR_SCAN=' .env; then ASKING=1; fi
fi
ask() { # ask "question" "default" -> the answer, or the default on Enter
  local answer
  printf '%s ' "$1" >&2
  read -r answer || answer=""
  [ -t 0 ] || echo >&2 # piped answers are not echoed
  echo "${answer:-$2}"
}

if [ "$ASKING" = 1 ]; then
  echo "▸ First-time setup. The answers go to .env; ./setup.sh --reconfigure asks again." >&2
  echo "  Only the analyzers your code needs start, so choosing less uses less memory." >&2
  echo >&2
  root=$(ask "Where is your code? Everything you review must be under it. [$MCR_ROOT]:" "$MCR_ROOT")
  root="${root/#\~/$HOME}"
  [ -d "$root" ] || { echo "✖ No such directory: $root" >&2; exit 1; }
  export MCR_ROOT="$(cd "$root" && pwd -P)"
  REPOS=()
  while IFS= read -r g; do REPOS+=("${g%/.git}"); done < <(find "$MCR_ROOT" -maxdepth 3 -name .git -prune 2>/dev/null | sort)
  SCAN=""
  if [ ${#REPOS[@]} -gt 0 ]; then
    echo >&2
    echo "Which repos should the stack be sized for? Their languages decide what starts." >&2
    for i in "${!REPOS[@]}"; do printf '  %2d) %s\n' $((i + 1)) "${REPOS[$i]#"$MCR_ROOT"/}" >&2; done
    picks=$(ask "Numbers separated by spaces, or Enter for all:" "")
    for n in $picks; do
      case "$n" in ''|*[!0-9]*) echo "  skipped '$n': not a number" >&2; continue ;; esac
      if [ "$n" -ge 1 ] && [ "$n" -le ${#REPOS[@]} ]; then SCAN="${SCAN:+$SCAN:}${REPOS[$((n - 1))]}"; else echo "  skipped $n: not in the list" >&2; fi
    done
  fi
fi
# The saved choice, unless repos were named on the command line (which become the new choice).
if [ ${#ARGS[@]} -eq 0 ] && [ -n "$SCAN" ]; then
  IFS=':' read -r -a ARGS <<<"$SCAN"
  [ "$ASKING" = 1 ] || echo "▸ Repos from .env (MCR_SCAN); ./setup.sh --reconfigure to change." >&2
elif [ ${#ARGS[@]} -gt 0 ]; then
  SCAN=$(IFS=':'; echo "${ARGS[*]}")
fi

echo "▸ Building the gateway image…" >&2
docker compose build -q review-mcp </dev/null

echo "▸ Scanning ${ARGS[*]:-$MCR_ROOT}…" >&2
detected=$(docker compose run --rm --no-deps -T review-mcp node src/setup.ts ${ARGS[@]+"${ARGS[@]}"} </dev/null)
profiles=$(sed -n 's/^COMPOSE_PROFILES=//p' <<<"$detected")

if [ "$ASKING" = 1 ] && [ -n "$profiles" ]; then
  echo >&2
  echo "Found: $profiles. Skip any? jvm and dotnet are the heaviest." >&2
  SKIP=$(ask "Profiles to skip, comma-separated, or Enter to keep all:" "")
  SKIP=$(tr -d ' ' <<<"$SKIP")
fi

if [ "$OFFLINE" = 1 ]; then
  echo "▸ Offline: no LLM reviewers and no Jev; no code leaves the machine." >&2
elif [ -s secrets/llm_api_key ]; then
  profiles="${profiles:+$profiles,}llm"
  echo "▸ LLM reviewers on: ${MCR_LLM_MODEL:-glm-5.3-flash} at ${MCR_LLM_BASE_URL:-https://api.grunden.ai/v1}" >&2
else
  echo "▸ No secrets/llm_api_key: the harness model reviews what the analyzers cannot." >&2
fi

# Profiles the user chose never to start.
if [ -n "$SKIP" ]; then
  kept=""
  IFS=',' read -r -a all <<<"$profiles"
  for p in ${all[@]+"${all[@]}"}; do
    case ",$SKIP," in *",$p,"*) ;; *) kept="${kept:+$kept,}$p" ;; esac
  done
  profiles="$kept"
  echo "▸ Skipping (MCR_SKIP_PROFILES): $SKIP" >&2
fi

HAD_SCAN=0; grep -q '^MCR_SCAN=' .env && HAD_SCAN=1
grep -vE '^(COMPOSE_PROFILES|MCR_PROFILES|MCR_ROOT|MCR_JEV|MCR_SCAN|MCR_SKIP_PROFILES)=' .env > .env.tmp || true
{
  cat .env.tmp
  echo "MCR_ROOT=$MCR_ROOT"
  if [ "$ASKING" = 1 ] || [ -n "$SCAN" ] || [ "$HAD_SCAN" = 1 ]; then echo "MCR_SCAN=$SCAN"; fi
  if [ -n "$SKIP" ]; then echo "MCR_SKIP_PROFILES=$SKIP"; fi
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
