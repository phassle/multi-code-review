// MCP over streamable HTTP (stateless). Any harness connects to
// http://127.0.0.1:7700/mcp; the analyzers sit behind it on a network
// without egress. The reviewed repos are mounted read-only: tools that change
// .mcr/decisions.yml return the new file for the harness to write.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { infoOf, parseRegistry } from './analyzers.ts';
import { activeProfiles, registryFor } from './catalog.ts';
import { detect, detectionMarkdown, missingProfiles } from './detect.ts';
import { ACTIONS, appendDecisions, ruleKey, DECISIONS_FILE, matchDecision, triageGroups, type NewDecision } from './decisions.ts';
import { CATEGORIES, fingerprint, type Finding } from './findings.ts';
import { cloudTemplates, everything, gitUser, resolveRepo } from './git.ts';
import { askJev, JEV_MODEL, jevEnabled } from './jev.ts';
import { defaultLevels } from './settings.ts';
import { metaOf, reportId, reportResponse, reviewHtml, type Stored } from './html.ts';
import { reportStore } from './reportStore.ts';
import { compactReview, fixReport, fixReportMarkdown, toMarkdown, triageMarkdown } from './report.ts';
import { codeExcerpts, loadDecisions, readLines, runReview, type Review, type ReviewOptions } from './review.ts';

function fail(message: string): never {
  throw new Error(message);
}

const VERSION = '0.3.0';
const PORT = Number(process.env.PORT ?? 7700);
const PUBLIC_PORT = process.env.MCR_PUBLIC_PORT ?? String(PORT);
const MCR_ROOT: string = process.env.MCR_ROOT ?? fail('MCR_ROOT is not set');
const PROFILES = activeProfiles(process.env.MCR_PROFILES);
// An explicit MCR_ANALYZERS wins; otherwise the catalog entries of the running profiles.
const REGISTRY = parseRegistry(process.env.MCR_ANALYZERS || registryFor(PROFILES));
const LEVELS = defaultLevels(process.env.MCR_LEVELS);
for (const n of LEVELS.notes) console.warn(n);
const JUDGE = jevEnabled() ? { ask: askJev, model: JEV_MODEL } : undefined;
const ALLOWED_HOSTS = (process.env.MCR_ALLOWED_HOSTS ?? `127.0.0.1:${PUBLIC_PORT},localhost:${PUBLIC_PORT}`).split(',');
// Where people open the HTML reports; the first allowed host unless set.
const REPORTS_URL = (process.env.MCR_REPORTS_URL ?? `http://${ALLOWED_HOSTS[0]}/reports`).replace(/\/$/, '');

// Recent reviews and their findings, so triage and reports need not re-run the
// analyzers. In memory: a restart forgets them, the decisions file does not.
const STORE = reportStore(process.env.MCR_REPORT_STORE);

const reviews = new Map<string, Review>();
const findingsById = new Map<string, { finding: Finding; reviewId: string; repoRoot: string }>();
const REVIEW_LIMIT = 20;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Keep the readable page as it is now, code included, for after a restart or the repo is gone. */
function storeReport(review: Review): void {
  if (!STORE) return;
  const page = reviewHtml(review, codeExcerpts(review.repoRoot));
  STORE.put(metaOf(review), page).catch((e: Error) => console.error(`${review.id} not stored: ${e.message}`));
}

function remember(review: Review): Review {
  if (!reviews.has(review.id)) storeReport(review);
  reviews.set(review.id, review);
  while (reviews.size > REVIEW_LIMIT) reviews.delete(reviews.keys().next().value as string);
  for (const finding of review.findings) findingsById.set(finding.id, { finding, reviewId: review.id, repoRoot: review.repoRoot });
  while (findingsById.size > 20_000) findingsById.delete(findingsById.keys().next().value as string);
  return review;
}

function text(value: string) {
  return { type: 'text' as const, text: value };
}

const reviewInput = {
  path: z.string().describe('Absolute path to the repository or worktree, as on the host. Must be inside MCR_ROOT.'),
  base: z.string().optional().describe('Branch or commit to diff against. Default: the first of origin/develop, origin/main, origin/master, develop, main, master.'),
  scope: z.enum(['diff', 'all']).optional().describe('diff (default): what changed since the merge base. all: every file in the repo, for a baseline triage.'),
  categories: z.array(z.enum(CATEGORIES)).optional().describe('Only report these categories.'),
  include_preexisting: z.boolean().optional().describe('Also list findings on unchanged lines of changed files. They never block. Default false.'),
};

type ReviewArgs = { path: string; base?: string; scope?: 'diff' | 'all'; categories?: Array<(typeof CATEGORIES)[number]>; include_preexisting?: boolean };

function options(a: ReviewArgs, analyzers?: string[]): ReviewOptions {
  return { path: a.path, base: a.base, scope: a.scope, categories: a.categories, includePreexisting: a.include_preexisting, analyzers, profiles: PROFILES, judge: JUDGE, defaultLevels: process.env.MCR_LEVELS ? LEVELS.levels : undefined, today: today() };
}

/** A cached review by id, or a fresh one from the review arguments. */
async function reviewFor(a: Partial<ReviewArgs> & { review_id?: string }): Promise<Review> {
  if (a.review_id) {
    const cached = reviews.get(a.review_id);
    if (!cached) throw new Error(`${a.review_id} is not a recent review; pass path to run a new one`);
    return cached;
  }
  if (!a.path) throw new Error('pass review_id or path');
  return remember(await runReview(REGISTRY, MCR_ROOT, options(a as ReviewArgs)));
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'multi-code-review', version: VERSION });

  server.registerTool(
    'list_analyzers',
    {
      title: 'List analyzers',
      description: 'The analyzers this gateway can run, with the languages, file extensions and review categories each covers.',
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [text(JSON.stringify(await Promise.all(REGISTRY.map(infoOf)), null, 2))] }),
  );

  server.registerTool(
    'detect_stack',
    {
      title: 'Detect stack',
      description:
        'What a repository is made of (languages, projects) and, per category, which running analyzer covers each stack or that only you (the model) do. ' +
        'Also names the compose profiles the repo needs that are not running; tell the user to run ./setup.sh then.',
      inputSchema: { path: reviewInput.path },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path }) => {
      const repoRoot = await resolveRepo(path, MCR_ROOT);
      const { files } = await everything(repoRoot);
      const d = detect(files, PROFILES, cloudTemplates(repoRoot, files));
      const missing = missingProfiles(d, PROFILES);
      const tail = missing.length ? `\n\n⚠️ Not running: ${missing.join(', ')}. Run \`./setup.sh\` in multi-code-review to start them.` : '';
      return { content: [text(detectionMarkdown(d, repoRoot) + tail), text(JSON.stringify({ ...d, running: PROFILES, missing }))] };
    },
  );

  server.registerTool(
    'run_review',
    {
      title: 'Review changes',
      description:
        'Review what changed in a working tree since its merge base with `base` (committed, staged, unstaged, untracked), or the whole repo with scope "all". ' +
        'Runs every applicable analyzer in parallel, applies the decisions recorded in .mcr/decisions.yml, and returns findings grouped by category ' +
        '(security, architecture, best-practices, testing, correctness, reliability). A finding blocks when it is new, high severity and not accepted. ' +
        'Returns a Markdown report and the JSON result; its review id (R-xxxxxxxx) can be passed to triage_queue and fix_report.',
      inputSchema: reviewInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const review = remember(await runReview(REGISTRY, MCR_ROOT, options(a)));
      return { content: [text(toMarkdown(review, codeExcerpts(review.repoRoot), `${REPORTS_URL}/${review.id}`)), text(JSON.stringify(compactReview(review)))] };
    },
  );

  server.registerTool(
    'run_analyzer',
    {
      title: 'Run one analyzer',
      description: 'Like run_review, but with only the named analyzers (see list_analyzers).',
      inputSchema: { ...reviewInput, analyzers: z.array(z.string()).min(1).describe('Analyzer names, e.g. ["semgrep"].') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const review = remember(await runReview(REGISTRY, MCR_ROOT, options(a, a.analyzers)));
      return { content: [text(toMarkdown(review, codeExcerpts(review.repoRoot), `${REPORTS_URL}/${review.id}`)), text(JSON.stringify(compactReview(review)))] };
    },
  );

  server.registerTool(
    'get_finding',
    {
      title: 'Get a finding',
      description: 'Full detail for one finding id (F-xxxxxxxx) from a recent review: rule, help link, fingerprint, decision, and the review it came from.',
      inputSchema: { id: z.string().regex(/^F-[0-9a-f]{8}$/) },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const hit = findingsById.get(id);
      if (!hit) return { isError: true, content: [text(`${id} is not in a recent review; run run_review again.`)] };
      return { content: [text(JSON.stringify(hit, null, 2))] };
    },
  );

  const fromReview = {
    review_id: z.string().regex(/^R-[0-9a-f]{8}$/).optional().describe('A recent review to reuse. Without it, a new review runs with the other arguments.'),
    ...reviewInput,
    path: reviewInput.path.optional(),
  };

  server.registerTool(
    'triage_queue',
    {
      title: 'Triage queue',
      description:
        'The findings that have no decision yet, one group per rule, most severe and most frequent first: the agenda for a triage session with the user. ' +
        'Walk it one group at a time, ask the user to choose fix, accept, false-positive or disable (and for which scope), then call record_decisions.',
      inputSchema: fromReview,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const review = await reviewFor(a);
      const groups = triageGroups(review.findings, review.decisions);
      return { content: [text(triageMarkdown(review, groups)), text(JSON.stringify({ review_id: review.id, groups }))] };
    },
  );

  server.registerTool(
    'fix_report',
    {
      title: 'Fix report',
      description:
        'What needs doing: findings decided "fix" that are still there, blocking findings with no decision, rules still undecided, ' +
        'accepted norm breaks with their reasons, and decisions that matched nothing and can be removed. A Markdown checklist plus JSON.',
      inputSchema: fromReview,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const review = await reviewFor(a);
      const report = fixReport(review);
      return { content: [text(fixReportMarkdown(review, report, codeExcerpts(review.repoRoot), `${REPORTS_URL}/${review.id}`)), text(JSON.stringify({ review_id: review.id, ...report }))] };
    },
  );

  const decisionInput = z.object({
    action: z.enum(ACTIONS).describe('fix: keep it on the to-fix list. accept: the norm is broken on purpose. false-positive: the tool is wrong here. disable: the rule does not apply to this repo or these paths.'),
    applies_to: z.enum(['occurrence', 'paths', 'rule']).describe('occurrence: just this finding. paths: the rule within the given globs. rule: the rule everywhere in the repo.'),
    finding_id: z.string().regex(/^F-[0-9a-f]{8}$/).optional().describe('A finding from a recent review.'),
    rule: z.string().optional().describe('analyzer:ruleId, for a finding without an id, e.g. one from your own review: "llm:missing-idempotency-key".'),
    file: z.string().optional().describe('With rule, for applies_to occurrence: the file relative to the repo root.'),
    line: z.number().int().positive().optional().describe('With rule and file, for applies_to occurrence.'),
    paths: z.array(z.string()).optional().describe('Globs relative to the repo root, for applies_to paths, e.g. ["src/db/migrations/**"].'),
    reason: z.string().min(3).describe('Why, in the words of the user. Required: it is what later reviews and readers see.'),
    ref: z.string().optional().describe('An ADR, issue or doc that backs the decision.'),
    expires_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('When to look at it again; after this the findings come back.'),
  });

  server.registerTool(
    'record_decisions',
    {
      title: 'Record decisions',
      description:
        `Turn the user's triage choices into entries for ${DECISIONS_FILE}. The repo is mounted read-only, so this returns the complete new file: ` +
        'write it to the repo verbatim, show the user the diff, and let it be committed and reviewed like code. Later reviews match these entries.',
      inputSchema: { path: reviewInput.path, decisions: z.array(decisionInput).min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, decisions }) => {
      const repoRoot = await resolveRepo(path, MCR_ROOT);
      const by = await gitUser(repoRoot);
      const readLine = readLines(repoRoot);
      const additions: NewDecision[] = decisions.map((d, i) => {
        const known = d.finding_id ? findingsById.get(d.finding_id) : undefined;
        if (d.finding_id && !known) throw new Error(`decision ${i + 1}: ${d.finding_id} is not in a recent review`);
        if (known && known.repoRoot !== repoRoot) throw new Error(`decision ${i + 1}: ${d.finding_id} belongs to ${known.repoRoot}`);
        const rule = known ? ruleKey(known.finding) : (d.rule ?? fail(`decision ${i + 1}: pass finding_id or rule`));
        const base = { action: d.action, rule, reason: d.reason, ref: d.ref, expires_on: d.expires_on, decided_by: by };
        if (d.applies_to === 'rule') return base;
        if (d.applies_to === 'paths') {
          if (!d.paths?.length) throw new Error(`decision ${i + 1}: applies_to paths needs paths`);
          return { ...base, paths: d.paths };
        }
        if (known) return { ...base, fingerprint: known.finding.fingerprint, paths: [known.finding.file] };
        if (!d.file || !d.line) throw new Error(`decision ${i + 1}: an occurrence without finding_id needs file and line`);
        const [analyzer = '', ...rest] = rule.split(':');
        const fp = fingerprint({ analyzer, ruleId: rest.join(':'), file: d.file }, readLine(d.file, d.line));
        return { ...base, fingerprint: fp, paths: [d.file] };
      });
      let existing: string | undefined;
      try {
        existing = readFileSync(join(repoRoot, DECISIONS_FILE), 'utf8');
      } catch {
        existing = undefined;
      }
      const { text: content, ids } = appendDecisions(existing, additions, today());
      const summary = `Write this to \`${join(repoRoot, DECISIONS_FILE)}\` (${existing ? 'replacing' : 'creating'} it). New: ${ids.join(', ')}.`;
      return { content: [text(summary), text(content)] };
    },
  );

  server.registerTool(
    'apply_decisions',
    {
      title: 'Apply decisions to your own findings',
      description:
        `Check findings from your own (model) review against ${DECISIONS_FILE}, the same way analyzer findings are checked, ` +
        'so a norm break the team already accepted is reported as info. Use rule ids of the form "llm:<short-slug>" and keep them stable.',
      inputSchema: {
        path: reviewInput.path,
        findings: z.array(z.object({ rule: z.string(), file: z.string(), line: z.number().int().positive() })).min(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, findings }) => {
      const repoRoot = await resolveRepo(path, MCR_ROOT);
      const { decisions, notes } = loadDecisions(repoRoot);
      const readLine = readLines(repoRoot);
      const result = findings.map((f) => {
        const [analyzer = '', ...rest] = f.rule.split(':');
        const ruleId = rest.join(':');
        const fp = fingerprint({ analyzer, ruleId, file: f.file }, readLine(f.file, f.line));
        const d = matchDecision({ analyzer, ruleId, file: f.file, fingerprint: fp }, decisions, today());
        return { ...f, decision: d ? { id: d.id, action: d.action, reason: d.reason, ref: d.ref } : null };
      });
      return { content: [text(JSON.stringify({ findings: result, notes }, null, 2))] };
    },
  );

  return server;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  return raw ? JSON.parse(raw) : undefined;
}

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  // The page has no scripts and loads nothing: only its own inline styles.
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

/** What the report store has for this request; nothing when there is no store or it does not answer. */
async function storedFor(url: string, host: string | undefined): Promise<Stored> {
  if (!STORE || !host || !ALLOWED_HOSTS.includes(host)) return { reports: [] };
  try {
    const id = reportId(url);
    const page = id && !reviews.has(id) ? await STORE.get(id) : undefined;
    const reports = url === '/reports' || (id && !page && !reviews.has(id)) ? await STORE.list() : [];
    return { reports, page, ttlDays: await STORE.ttlDays() };
  } catch (e) {
    console.error(`report-store: ${(e as Error).message}`);
    return { reports: [] };
  }
}

/** GET /reports and /reports/R-xxxxxxxx; see reportResponse. */
async function serveReport(url: string, host: string | undefined, res: ServerResponse): Promise<void> {
  const r = reportResponse(url, host, ALLOWED_HOSTS, reviews, (review) => codeExcerpts(review.repoRoot), await storedFor(url, host));
  res.writeHead(r.status, r.body === undefined ? {} : HTML_HEADERS).end(r.body);
}

createServer(async (req, res) => {
  try {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, profiles: PROFILES, judge: JUDGE?.model ?? null, analyzers: REGISTRY.map((a) => a.name) }));
      return;
    }
    if (req.method === 'GET' && (req.url === '/reports' || req.url?.startsWith('/reports/'))) {
      await serveReport(req.url, req.headers.host, res);
      return;
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      // Stateless: no server-initiated stream and no sessions to delete.
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: ALLOWED_HOSTS,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, await readBody(req));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (e as Error).message }));
  }
}).listen(PORT, () => console.log(`multi-code-review gateway ${VERSION} on :${PORT}; analyzers: ${REGISTRY.map((a) => a.name).join(', ') || 'none'}; judge: ${JUDGE?.model ?? 'off'}`));
