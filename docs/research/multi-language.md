# Research: one review setup for every company and language

Goal: every company runs the same setup, regardless of stack. There are analyzers for
every language, but a repo only runs the ones that match its code. The result is always
sorted into six categories: security, architecture, best-practices, testing,
correctness, reliability.

## 1. Principle: one catalog per language, but only what is needed is started

- **Catalog:** one image per tool (`semgrep`, `ts`, `ruby`, `jvm`, `dotnet`,
  `python`, `go`, ...). Each image runs as several containers `<category>-<tool>`,
  as today.
- **Selection per company:** compose profiles per stack. A C# company runs
  `docker compose --profile core --profile dotnet up -d`. A Rails company runs
  `--profile core --profile ruby`. `core` (semgrep, gitleaks, osv-scanner) always
  runs, since they are language-independent.
- **Selection per repo:** the gateway already detects file extensions (`filesFor`). Add
  manifest detection (`package.json`, `Gemfile`, `build.gradle(.kts)`,
  `pom.xml`, `*.csproj`/`*.sln`, `go.mod`, `pyproject.toml`) and an optional
  `.mcr/config.yml` in the repo for overrides (disable a tool, specify a
  build command, name a monorepo's subprojects).
- **If an analyzer is missing** for a language or category, the verdict table shows
  "no analyzer", and the model takes the whole category. This already works that way today.

## 1b. A setup that picks analyzers by itself

The company runs one command. It reads the codebase, picks analyzers and starts
only those.

```bash
./setup.sh            # or: node setup.mjs [MCR_ROOT]
```

1. **Scan** all git repos under `MCR_ROOT`. Look for manifests and
   file extensions and skip `node_modules`, `vendor`, `bin/obj`, `build`, `.git`:

   | Finds | Stack → profile |
   |---|---|
   | `package.json`, `tsconfig.json` | `node` |
   | `Gemfile` | `ruby` |
   | `build.gradle(.kts)`, `pom.xml`, `*.kt`, `*.java` | `jvm` |
   | `*.csproj`, `*.sln` | `dotnet` |
   | `pyproject.toml`, `requirements*.txt` | `python` |
   | `go.mod` | `go` |
   | `Dockerfile`, `*.tf`, `.github/workflows` | `infra` |
   | always | `core` (semgrep, gitleaks, osv-scanner) |

2. **Write** `.env` with `COMPOSE_PROFILES=core,node,dotnet` (Compose reads the
   variable itself, so `docker compose up` then starts only the right containers)
   and `MCR_ANALYZERS` for exactly those services.
3. **Show** what was found and what is missing, e.g. "Ruby repo found but
   `bundle install` not run: RuboCop runs without plugins" or "C#: Roslyn
   requires a build, use SARIF import".
4. **Start** `docker compose up -d --build`, wait for `/healthz` and run
   `list_analyzers` as a check.

Rerun the setup when the company adds a new language. The gateway can also expose
the scan as an MCP tool (`detect_stack`), so the harness can say
"this repo is Kotlin but `jvm` is not started, run setup again".

The scan logic (files → stacks → profiles) is pure and tested in
`gateway/tests/` like the rest of the pure logic.

## 2. The categories: map the tools' own rule groups

Most tools already group their rules. Put the mapping in a declarative
file per tool (e.g. `analyzers/<tool>/categories.yml`) instead of
hardcoded lists as in `ts/adapter.mjs`. Unknown rule → `best-practices`.
Rules with a CWE tag → `security`.

| Tool | Tool's groups → category |
|---|---|
| Semgrep | `security`/`audit` → security, `correctness` → correctness, `performance` → reliability, rest → best-practices |
| RuboCop | `Security` → security, `Lint` → correctness, `RSpec`/`Minitest` → testing, `Style`/`Layout`/`Naming`/`Metrics` → best-practices |
| detekt (Kotlin) | `potential-bugs` → correctness, `coroutines`/`exceptions` → reliability, `style`/`naming`/`complexity` → best-practices |
| SpotBugs (Java) | `SECURITY` → security, `CORRECTNESS` → correctness, `MT_CORRECTNESS` → reliability, `BAD_PRACTICE`/`STYLE` → best-practices |
| PMD (Java) | `security`, `errorprone` → correctness, `multithreading` → reliability, `design` → architecture, `bestpractices`/`codestyle` → best-practices |
| Roslyn (C#) | `Security`, `Reliability` directly, `Usage` → correctness, `Design` → architecture, `Naming`/`Style`/`Maintainability` → best-practices |
| Ruff/Pylint (Python) | `S` (bandit) → security, `F`/`E` → correctness, `ASYNC`/`BLE` → reliability, `PT` → testing, rest → best-practices |
| golangci-lint | `gosec` → security, `govet`/`staticcheck` → correctness, `errcheck`/`contextcheck` → reliability, rest → best-practices |

## 3. Analyzers per language

All of the below can write SARIF, so they fit `_kit/serve.mjs` with a thin adapter.

| Language | correctness / best-practices | security | architecture | testing |
|---|---|---|---|---|
| JS/TS/Node | the repo's ESLint, `tsc` (exists) | semgrep, eslint-plugin-security | dependency-cruiser, the repo's `no-restricted-*` | diff-coverage from lcov |
| Ruby/Rails | RuboCop (+ rubocop-rails/rspec; SARIF via gem `code-scanning-rubocop`) | Brakeman (`-f sarif`), bundler-audit | packwerk | SimpleCov → diff-coverage |
| Kotlin | detekt (`--report sarif:`), ktlint (`--reporter=sarif`) | semgrep, osv-scanner | Konsist, ArchUnit tests in the repo | JaCoCo/Kover → diff-coverage |
| Java | PMD (`-f sarif`), Checkstyle, Error Prone, SpotBugs (`-sarif`) | Find Security Bugs (SpotBugs plugin), semgrep | ArchUnit tests in the repo | JaCoCo → diff-coverage |
| C# / .NET | Roslyn analyzers via `dotnet build -p:ErrorLog=x.sarif%2Cversion=2.1`, Roslynator | Roslyn `CA2xxx/CA3xxx`/`CA5xxx`, semgrep | NetArchTest / ArchUnitNET tests | Coverlet → diff-coverage |
| Python | Ruff (`--output-format sarif`), mypy/pyright | Bandit (`-f sarif`), semgrep | import-linter | coverage.py → diff-coverage |
| Go | golangci-lint (SARIF) | gosec (`-fmt sarif`), govulncheck | go-arch-lint | `go test -cover` → diff-coverage |
| All | – | gitleaks (secrets), osv-scanner (dependencies, offline database), Trivy | – | – |
| Infra | hadolint (Dockerfile) | checkov/tfsec (IaC), zizmor (GitHub Actions) | – | – |

## 4. The hard part: analyzers that must build the code

Three levels, by how much of the repo must be installed:

1. **Source only** (semgrep, gitleaks, osv-scanner, hadolint): works directly
   and without network. Gives coverage for all languages from day one.
2. **The repo's own config and dependencies** (ESLint, RuboCop with plugins, Ruff,
   detekt without type resolution): requires `npm ci` / `bundle install` in the repo.
   As today: the developer's machine has already done it.
3. **Requires a build** (`tsc`, Roslyn, SpotBugs, Error Prone, detekt with
   type resolution, Android lint): requires compilation and therefore dependencies.

Level 3 conflicts with "analyzers have no network". Two ways to solve it:

- **Prepare step:** a separate container with network *only* to
  package registries (egress proxy with allowlist: nuget.org, Maven Central,
  rubygems.org, npm) fills a cache volume. The analysis then runs offline against
  the cache. Code never runs with network while the repo is readable.
- **Import SARIF from CI:** the company builds in CI anyway. Let `run_review` read
  `.mcr/sarif/*.sarif` or a CI artifact and treat it like any other
  analyzer. Simplest for JVM and .NET, where the build is heavy.

Recommendation: start with levels 1–2 for all languages, and level 3 via SARIF import.

## 5. What is not language-dependent (already exists and carries the setup)

- **Decisions** (`tool:ruleId` + fingerprint) work for all languages without change.
- **Baseline triage** (`scope: "all"` → `triage_queue`) is essential when a
  company with an old codebase starts: group by rule, `disable` or
  `accept` in bulk, and then block only new findings.
- **The model's part** per category is language-independent. Give it a short
  stack-specific checklist (e.g. "N+1 in ActiveRecord", "async void in C#",
  "coroutine scope in Kotlin") chosen by detected language. Testing and
  architecture are where the tools are weakest and the model adds the most value.
- **Same images in CI** (roadmap step 3): GitHub Actions, and also Azure DevOps
  and GitLab, since the companies use different platforms. Output is SARIF.

## 6. Distribution to multiple companies: the licensing question

- **Semgrep rules:** Semgrep Rules License v1.0 only allows internal
  use and does not allow the rules to be distributed or made available
  to others as a service. Publishing an image with the rules
  baked in to other companies is likely distribution. The current
  `analyzers/semgrep/Dockerfile` fetches the rules when the company itself builds
  the image. Keep it that way: never publish the semgrep image to a registry, and
  let each company build locally. Have legal confirm this.
- **The engine** (Semgrep CE / Opengrep) is LGPL 2.1 and fine to use.
  Alternative rule sources: Opengrep's rules and third-party rules, but
  their license must be checked rule by rule.
- **CodeQL** is free only for open source. Private repos require a GitHub
  Code Security license, so it does not fit as a default.
- Other tools in the table above are open source and free to use.

## 7. Proposed order

1. Add `ruby` and `kotlin` to the semgrep image's language list (present in
   semgrep-rules but filtered out today). Add `gitleaks` and
   `osv-scanner` (offline). Then all languages have security coverage directly.
2. Move the category mapping to a data file per tool.
3. Compose profiles (`core`, `node`, `ruby`, `jvm`, `dotnet`, `python`, `go`,
   `infra`) and the setup command that scans the codebase and writes `.env` (1b).
4. Images: `ruby` (RuboCop + Brakeman), `jvm` (detekt, ktlint, PMD),
   `python` (Ruff + Bandit), `go` (golangci-lint + gosec).
5. SARIF import from CI for build-dependent tools (Roslyn, SpotBugs, tsc in large repos).
6. Diff-coverage from coverage reports for the testing category in all languages.
7. LLM containers per category (pi), with coordinator and risk levels in
   the gateway (sections 8–9).

## 8. Lessons from Cloudflare

Cloudflare runs AI review on all merge requests: 131,000 runs across 5,169
repos in 30 days, median 3 min 39 s and about 1 USD per review. They have a
coordinator and up to seven specialist reviewers. Most of it can be used as is.

| Cloudflare | What we take |
|---|---|
| One specialist per area, with a narrow prompt | One LLM specialist per category (six), reviewing only where the analyzers are blind |
| Each prompt has a **"What NOT to flag"** section (theoretical risks, unchanged code, "use library X"). This did the most against noise | Write one per category in the skill. A target of around 1 finding per review, not a long list |
| The coordinator deduplicates, moves miscategorized findings and filters false positives, and reads the code when unsure | `run_review` + `apply_decisions` already do deduplication and decisions. Add a judge step that moves findings to the right category |
| Risk levels: trivial (≤10 lines), lite (≤100), full (>100 lines, >50 files or sensitive paths like `auth/`, `crypto/`) | Same in the gateway: small diffs run analyzers and one general LLM reviewer, large diffs run all six |
| Bias toward approve. Only critical blocks | Matches our rule: blocks only if high, on a changed line, no decision |
| Lockfiles, minified, vendor and `@generated` are filtered out, but not migrations | Add the same filter in `git.ts` before routing |
| Language is not handled in the reviewers. The repo's `AGENTS.md` and a shared template per organization provide context | Each company gets a shared `AGENTS.md` template. The repo has its own on top |
| Standards (Codex) are RFCs split by domain and language. Each MUST/SHOULD is extracted to JSON with a stable slug | A company's standards can become `.mcr/standards.yml` with slugs. They can be decided on exactly as today via `llm:<slug>` |
| Rules that can be checked mechanically become lint rules (oxlint for TS, Rust and Go next) | Same principle as ours: deterministic first, the model only for the rest |
| RFC status *approved* informs and *enforced* blocks. Moving a rule between them is a separate step | New company or new rule: informs first and blocks only once the team has raised it. Fits the baseline triage |
| A new review sees earlier findings. Fixed ones are closed, "won't fix" replies are respected, `break glass` forces through (0.6% of MRs) | Roadmap step 3 (the GitHub bot). `break glass` corresponds to an `accept` with a reason |
| User-controlled MR text is stripped of tags against prompt injection | Applies to us when the bot reads PR text |
| Same agents locally (CLI) and in CI | Same: MCP locally and the same images in CI |
| Weak: architecture across system boundaries and subtle concurrency bugs | More deterministic tools for architecture (depcruise, ArchUnit, packwerk). Reliability leans on the model |

## 9. LLM containers (pi or similar)

Today the harness (Claude Code, Cursor ...) does the LLM part. With LLM reviewers as
their own containers, the review also works in CI and without a harness, and the company chooses
which model is used.

**Shape:** the same contract as other analyzers. `<category>-llm` (e.g.
`security-llm`, `architecture-llm`) answers `/info` and `/analyze`
and returns SARIF with `ruleId` = `llm:<slug>`. Then decisions,
fingerprint, triage and fix-report work without change.

**Engine:** [pi](https://pi.dev) (MIT) fits well. It can run headless
(`pi --mode rpc`, JSON over stdin/stdout) or as a library in Node
(`AgentSession` from `@mariozechner/pi-coding-agent`). That fits our adapter in
`.mjs`. Via `pi-ai` it supports Anthropic, OpenAI, Azure, Bedrock, Google,
OpenRouter and more. Alternatives: OpenCode (what Cloudflare uses) or
Claude Agent SDK. Build the adapter so the engine can be swapped.

**Per container:**
- One prompt per category with "What NOT to flag" (section 8) and the company's
  `AGENTS.md`, standards and the deterministic findings as input, so the
  model does not repeat them.
- The diff is written to files per file, not into the prompt. The reviewer reads only
  what concerns its category.
- Structured output (JSON schema: file, line, slug, severity, rationale). Findings
  without a line in the diff are discarded.
- Risk level from the gateway controls which LLM containers run and with which model.

**Coordinator** in the gateway after all containers: deduplicate between tools
and LLM, move findings to the right category and discard speculative findings.

**Security** (more important here than for regular analyzers, since the code being
reviewed may contain instructions to the model):
- Read tools only (read/grep/find/ls). No bash, edit or write.
  `MCR_ROOT` is mounted `:ro` as today.
- Own network `llm` with egress **only** to the LLM endpoint via an
  allowlist proxy, or to an AI gateway. No access to the
  `analyzers` network or the internet otherwise.
- API key as a Docker secret per company, never in the image or repo.
- Budget per review (tokens/USD) and timeouts per container (Cloudflare: 5
  min per reviewer, 25 min total).
- Companies that may not send code out can point to a local model (Ollama,
  vLLM) or Azure OpenAI/Bedrock in their own tenant. That is just a
  change of `MCR_LLM_PROVIDER`/`MCR_LLM_BASE_URL`.

**Setup (1b):** the `llm` profile is only added if the company specifies a provider.
Without it everything works as today, and the harness does the LLM part.

## 10. Decision models (Jev / TypeSafe)

Jev (`jev-1.13.0`) generates no text. It takes `state` and questions and answers
typed. `noul` gives P(yes), `choice` gives one of at most 255 alternatives with
probabilities, and `score` gives 2–10 ordered levels.

- **API:** `POST https://api.typesafe.ai/v1/systemone`.
- **Cost:** 0.042 USD per million input tokens. Output is free.
- **Limits:** 64k tokens per call, text only, best in English.
- **Weaknesses:** poor at counting, treats state as trusted (prompt
  injection), and has a bias toward the first alternative.
- **Not verified:** latency (vendor states 70–500 ms), EU residency and
  self-hosting.

**Built now** (`gateway/src/judge.ts` + `jev.ts`, Docker secret `typesafe_api_key`):

| Assessment | Primitive | Policy (in code) |
|---|---|---|
| Is the finding a real problem? | noul `real` | P < 0.15 → a blocking non-security finding requires human confirmation instead of blocking. The model can only *remove* blocking, never add it. |
| Is the LLM finding concrete, speculative or a style question? | 3 nouls in the same call | Speculative finding → info (`low`), never blocks. |
| The diff's risk level | score, 3 levels | `trivial` skips the LLM reviewers. Sensitive paths are always `full`. At low confidence the rules decide. |

Earlier decisions for the same `tool:ruleId` are sent along as context. Each answer
is stored on the finding (`assessment`) so the verdict can be explained. If the
model does not answer, the rules apply as before.

**Next steps (not built):**
- Suggest matching against an earlier decision when the fingerprint has changed (choice
  over candidate decisions, with "none" first).
- Find duplicates between tools.
- Ask whether the change should update `AGENTS.md`.
- Calibrate thresholds against `fix` and `false-positive` in `decisions.yml`.

**First experiment:** replay 150–300 decided findings offline. The goal is that
at least 30% of all false positives are caught, while at most 2% of fix findings
are wrongly downgraded.

## 11. Assessing PR code directly with Jev (design, not built)

Jev cannot review code freely. It can, however, quickly and cheaply answer a
checklist of narrow nouls about each changed chunk. The code handles splitting,
line selection and policy, and Jev makes the assessments.

1. **Unit:** hunk plus enclosing function, 4–6k tokens. Lines have an id and
   diff marker (`L42+`). Lockfiles and generated code are removed. Everything that can
   be counted or grepped is done in code.
2. **Checklist per category**, in one call per unit (fan-out). Examples:
   - **security:** SQL, shell or path string built from request data.
     Route without auth middleware.
   - **reliability:** network or DB call without timeout. Retry without
     idempotency.
   - **correctness:** off-by-one. Missing `await`.
   - **testing:** changed behavior, combined with a grep for tests that
     mention the function.
   - **architecture:** one noul per rule in `AGENTS.md`.
   - **All units:** an `attention` score for ranking.
3. **The line:** select instead of generate. A speculative `choice` over the
   added lines' ids in the same call. Rerunning with reversed order counteracts
   bias toward the first alternative.
4. **Findings:** `jev:<question>` in `decisions.yml`. Two thresholds per question: `route`
   sends the unit to the LLM, `report` creates its own finding. Jev never blocks
   alone. The thresholds are calibrated against `fix` and `false-positive` once there
   are at least 20 decisions.
5. **Cascade:**
   1. Jev assesses all units, for about 0.01 USD and 2–3 s for a PR with
      20 hunks.
   2. Only flagged units and top-k on `attention` go to the right category's
      LLM reviewer. Sensitive paths always go there.
   3. Without Jev, today's path runs.
6. **Evaluation:**
   - Build a labeled set from git history: SZZ from fix commits, plus
     CVEfixes and Defects4J.
   - Measure precision and recall per question against the LLM reviewer.
   - Then run in shadow mode. A question is activated only at precision ≥ 0.6.

Risk: Jev's code understanding is unmeasured. Nobody has published measurements on code review.

## Sources

- [TypeSafe docs](https://docs.typesafe.ai/llms.txt), [API](https://docs.typesafe.ai/api.md), [Confidence](https://docs.typesafe.ai/confidence.md), [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md), [Fan-out](https://docs.typesafe.ai/patterns/fan-out.md), [SDE cascade](https://docs.typesafe.ai/cookbooks/sde_cascade.md), [DPA](https://typesafe.ai/legal/data-processing)

- [pi RPC mode](https://pi.dev/docs/latest/rpc), [pi-coding-agent README](https://app.unpkg.com/@mariozechner/pi-coding-agent@0.73.1/files/README.md), [Pi sandbox analysis](https://agent-safehouse.dev/docs/agent-investigations/pi)

- [Cloudflare: Orchestrating AI Code Review at scale](https://blog.cloudflare.com/ai-code-review/), [How Cloudflare enforces engineering standards using AI](https://blog.cloudflare.com/engineering-standards-enforcement/), [The AI engineering stack we built internally](https://blog.cloudflare.com/internal-ai-engineering-stack/)

- [Semgrep licensing](https://semgrep.dev/docs/licensing), [Semgrep Rules License](https://semgrep.dev/legal/rules-license), [Important updates to Semgrep OSS](https://semgrep.dev/blog/2024/important-updates-to-semgrep-oss)
- [Opengrep fork (InfoQ)](https://www.infoq.com/news/2025/02/semgrep-forked-opengrep)
- [code-scanning-rubocop](https://rubygems.org/gems/code-scanning-rubocop)
- [SARIF from .NET projects (Meziantou)](https://www.meziantou.net/how-to-output-a-sarif-file-from-a-dotnet-project.htm)

<!-- CI smoke test: safe to close -->
