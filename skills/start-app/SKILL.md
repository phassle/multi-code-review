---
name: start-app
description: Start multi-code-review under Aspire (or Docker Compose) and report where it answers - the MCP URL, its tools, the running analyzers, and a link to the Aspire dashboard with every container's logs. Use when asked to start, run or check the code-review service, to get its MCP URL or dashboard, or before a review when the MCP server does not answer.
---

# start-app

Run every command from the multi-code-review repo root (the folder with
`aspire.config.json`). Use `--non-interactive` with the Aspire CLI.

## 1. Already running?

```bash
node scripts/status.mjs
```

Exit 0: it is up; go to step 3 and report. Exit 1: start it.

## 2. Start

```bash
aspire start --non-interactive
aspire wait review-mcp --non-interactive --timeout 600
```

- The first start builds the images and scans the codebase (`setup.sh --dry-run`
  writes the compose profiles to `.env`); it can take minutes.
- No Aspire CLI or no .NET: `./setup.sh` starts the same stack with Docker
  Compose only (no dashboard).
- Only `secrets/llm_api_key` and `secrets/typesafe_api_key` turn on the LLM
  reviewers and Jev. `./setup.sh --offline` keeps all code on the machine.

## 3. Report

Run `node scripts/status.mjs` and give the user, as links:

- the **MCP URL** (and the `claude mcp add` line),
- the **reports** link (one readable HTML page per review),
- the **dashboard** link,
- the **tools** table, and the profiles, judge and analyzer count.

## Logs and troubleshooting

Every container is its own Aspire resource, named like its container:

```bash
aspire describe --non-interactive              # state, health, dashboard link per resource
aspire logs review-mcp --non-interactive       # the gateway
aspire logs correctness-llm --non-interactive  # one analyzer
aspire logs stack --non-interactive            # docker compose itself: builds, starts, errors
```

- A new language in the codebase: dashboard command **Rescan codebase** on
  `stack` (or `./setup.sh --dry-run`), then restart: `aspire stop && aspire start`.
- Never `docker compose down` while Aspire runs; stop with `aspire stop`.
