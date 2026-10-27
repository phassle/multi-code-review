# AGENTS.md

Be extremely concise. README.md has the architecture, tools and decision format.

## Map

- `gateway/src/` – MCP server (`review-mcp`, 127.0.0.1:7700/mcp).
  - `server.ts` – MCP tool registration, HTTP, env (`MCR_ROOT`, `MCR_ANALYZERS`, `MCR_ALLOWED_HOSTS`).
  - `review.ts` – orchestration: diff → pick analyzers → run in parallel → classify → decisions → report.
  - `git.ts`, `analyzers.ts` – I/O (git CLI, analyzer HTTP).
  - `diff.ts`, `findings.ts`, `decisions.ts`, `report.ts`, `catalog.ts`, `detect.ts`, `settings.ts`, `judge.ts` – pure logic.
  - `jev.ts` – TypeSafe Jev client (I/O); `setup.ts` – stack scan run by `setup.sh`.
- `analyzers/_kit/serve.mjs` – shared contract: `GET /info`, `POST /analyze` → SARIF 2.1.0; path checks, one-category filter.
- `analyzers/<tool>/adapter.mjs` + `Dockerfile` – `semgrep`, `ts` (eslint/tsc), `pmd`, `detekt`, `dotnet` (roslyn), `php` (phpstan), `cppcheck`, `python` (ruff/bandit), `ruby` (rubocop/brakeman), `go` (golangci-lint), `gitleaks` (secrets, core), `hadolint` (Dockerfiles, infra), `checkov` (cloud IaC: AWS, Azure, GCP; infra), `llm`. `gitleaks` and `hadolint` are the minimal examples to copy. `MCR_TOOLS` picks the tool where an image has two.
- `compose.yaml` – one service per `<category>-<tool>`, grouped in profiles; must match `catalog.ts` (tested). Plus `review-mcp` and `report-store`.
- `report-store/` – keeps review pages (HTML with code) on the `reports` volume for `MCR_REPORT_TTL_DAYS` (7). Only the gateway reaches it (`reports` network, internal); `gateway/src/reportStore.ts` is its client.
- `setup.sh` – detects stacks, writes `.env` (`COMPOSE_PROFILES`), starts compose. Keys are Docker secrets in `secrets/`.
- `aspire-apphost/apphost.mts` – Aspire wrapper: runs the compose stack, one log resource per container from `catalog.ts`. `scripts/status.mjs` prints MCP URL, tools, dashboard.
- `scripts/mcr.mjs` – CLI over the gateway's MCP tools (review, fix-report, triage, detect, analyzers); exit 1 on blocking. Zero deps.
- `scripts/github-review.mjs` – pure: a review as a GitHub PR review (summary + P1/P2/P3 line comments).
- `.github/workflows/review.yml` – reusable PR workflow (runs the CLI, posts the review); `self-review.yml` runs it on this repo. Caller template in `examples/github-workflow.yml`.
- `skills/start-app/` – start the service and report where it answers.
- `skills/multi-code-review/SKILL.md` – how a harness drives the tools. Keep in sync with tool changes.
- `.claude-plugin/`, `.mcp.json` – Claude Code plugin packaging.

## Rules

- Gateway: TypeScript run by Node 24 directly. Imports end in `.ts`; erasable syntax only (no enums, namespaces, parameter properties). No build step.
- Analyzers: plain `.mjs`, zero dependencies, only `_kit/serve.mjs`. One category per container, named `<category>-<tool>`. Never give them network access (`analyzers` network is `internal`); only `*-llm` reach their API, via `llm-egress`.
- Models (LLM, Jev) may only take blocking away, never add it, and never alone for security.
- Categories are fixed: security, architecture, best-practices, testing, correctness, reliability (`findings.ts` and `serve.mjs` must agree).
- Decisions (`.mcr/decisions.yml` in reviewed repos) key on `tool:ruleId`, never container names. Match on fingerprint (tool, rule, file, flagged code), not line numbers.
- Blocking = changed line + high severity (medium too at level `maximum` in `.mcr/settings.yml`) + no accepting decision. Don't change this silently.
- Pure modules stay free of I/O and get tests in `gateway/tests/`. Adapter tests sit next to the adapter (`*.test.mjs`).
- The gateway never writes to reviewed repos; `record_decisions` returns the file for the harness to write.
- Containers stay `read_only`, `cap_drop: ALL`, `no-new-privileges`; `MCR_ROOT` mounted `:ro` at the host path.

## Adding an analyzer

1. `analyzers/<tool>/adapter.mjs` exporting `info` and `analyze({ root, files, category })`, calling `serve()`.
2. `analyzers/<tool>/Dockerfile` (build context `analyzers/`).
3. One `<category>-<tool>` service per category in `compose.yaml` under a profile, and the same entries in `gateway/src/catalog.ts`; map its stack in `detect.ts`.
4. Update README tables.

- Model budgets: Jev requests < 32k tokens (`judge.ts`), LLM reviewer context < `MCR_LLM_CONTEXT_TOKENS` (190k, Grunden).

## Done when

```bash
cd gateway && npm test && npm run typecheck
./setup.sh                     # then run_review serves
```
