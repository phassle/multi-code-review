// Reviews as HTML pages for people: served by the gateway at /reports. Pure.
// Self-contained (inline CSS, no scripts, no external assets), so the page can
// be served with a CSP that allows nothing but its own styles. Every value is
// escaped by the `html` tag; only fragments built with `html` pass through.

import { ruleKey } from './decisions.ts';
import { CATEGORIES, type Finding } from './findings.ts';
import { groupFindings, jevFixList, jevSummary, where, type CodeOf } from './report.ts';
import type { Review } from './review.ts';

/** Code excerpts shown per rule group; the rest are listed by location only. */
const MAX_EXCERPTS_PER_GROUP = 5;

export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Markup that is already safe: made by `html`, never from a plain string. */
export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

type Part = Html | string | number | boolean | undefined | null | Part[];

function render(p: Part): string {
  if (p === undefined || p === null || p === false || p === true) return '';
  if (p instanceof Html) return p.value;
  if (Array.isArray(p)) return p.map(render).join('');
  return esc(p);
}

/** Template tag: escapes every interpolated value unless it is Html; arrays are joined; null, undefined and booleans render nothing. */
export function html(strings: TemplateStringsArray, ...values: Part[]): Html {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? '');
  });
  return new Html(out);
}

/** Only http(s) links; anything else is shown as text. */
function link(href: string | undefined, label: string): Html {
  return href && /^https?:\/\//.test(href) ? html`<a href="${href}" rel="noreferrer noopener">${label}</a>` : html`${label}`;
}

type Tone = 'block' | 'warn' | 'info' | 'ok' | 'todo';

function status(f: Finding): { tone: Tone; label: string } {
  if (f.decision?.action === 'accept') return { tone: 'ok', label: `Accepted ${f.decision.id}` };
  if (f.decision?.action === 'false-positive') return { tone: 'ok', label: `False positive ${f.decision.id}` };
  if (f.blocking) return { tone: 'block', label: 'Blocking' };
  if (f.decision?.action === 'fix') return { tone: 'todo', label: `To fix ${f.decision.id}` };
  return f.severity === 'low' ? { tone: 'info', label: 'Info' } : { tone: 'warn', label: 'Warning' };
}

const pill = (tone: Tone, label: string | number) => html`<span class="pill ${tone}">${label}</span>`;

function jev(g: Finding[]): Html | undefined {
  const j = jevSummary(g);
  if (!j) return undefined;
  const tone = j.hi >= 0.6 ? 'block' : j.lo < 0.2 ? 'ok' : 'warn';
  const human = j.humanDecides ? html` <span class="muted">Security: Jev never unblocks alone; a human decides.</span>` : undefined;
  return html`<p class="jev"><span class="meter ${tone}"><span class="w${Math.round(j.hi * 10)}"></span></span> Jev${j.judged < j.total ? ` (judged ${j.judged} of ${j.total})` : ''} p(real) <b>${j.range}</b>, ${j.verdicts}${human}</p>`;
}

function code(f: Finding, codeOf?: CodeOf): Html | undefined {
  const text = codeOf?.(f);
  if (!text) return undefined;
  const lines = text.split('\n').map((l, i) => [i ? '\n' : '', l.startsWith('>>') ? html`<span class="hit">${l}</span>` : l]);
  return html`<pre><code>${lines}</code></pre>`;
}

function header(r: Review): Html {
  const scope = r.scope === 'all' ? html`Whole repository, ${r.changedFiles} files` : html`${r.changedFiles} changed files vs <code>${r.base}</code> (${r.mergeBase.slice(0, 8)})`;
  const verdict = r.blocking > 0 ? pill('block', `${r.blocking} blocking`) : pill('ok', 'Passed');
  const judged = r.judged ? `, ${r.judged} judged by Jev` : '';
  return html`<header>
  <p class="eyebrow">multi-code-review · <a href="/reports">All reports</a></p>
  <h1>Review <code>${r.id}</code> ${verdict}</h1>
  <p class="muted"><code>${r.repoRoot}</code><br>${scope} · head <code>${r.head.slice(0, 8)}</code> · ${r.findings.length} findings, ${r.preexisting} pre-existing, ${r.suppressed} hidden by decisions${judged}</p>
</header>`;
}

function categoryTable(r: Review): Html {
  const rows = CATEGORIES.map((category) => {
    const runs = r.analyzers.filter((a) => a.category === category);
    const findings = r.findings.filter((f) => f.category === category);
    const blocking = findings.filter((f) => f.blocking).length;
    const failed = runs.filter((a) => a.error);
    let verdict: Html;
    if (runs.length === 0) verdict = pill('info', 'Model review only');
    else if (blocking > 0) verdict = pill('block', `${blocking} blocking`);
    else if (failed.length > 0) verdict = pill('warn', `${failed.map((a) => a.name).join(', ')} failed`);
    else if (runs.every((a) => a.skipped)) verdict = pill('info', 'Nothing to check');
    else verdict = pill('ok', 'Pass');
    const ran = runs.filter((a) => !a.skipped).map((a) => a.name).join(', ') || '–';
    const count = findings.length ? html`<a href="#${category}">${findings.length}</a>` : '0';
    return html`<tr><td>${category}</td><td>${verdict}</td><td class="num">${count}</td><td class="small">${ran}</td></tr>`;
  });
  return html`<table><thead><tr><th>Category</th><th>Verdict</th><th class="num">Findings</th><th>Analyzers that ran</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function fixList(r: Review, codeOf?: CodeOf): Html | undefined {
  if (!r.findings.some((f) => f.assessment)) return undefined;
  const fix = jevFixList(r.findings);
  const items = fix.map(
    (f, i) => html`<article class="card">
  <h3><span class="n">${i + 1}</span> ${ruleKey(f)} ${pill(status(f).tone, `${f.category} · ${f.severity}`)}</h3>
  <p><code>${where(f)}</code> · <span class="muted">${f.id}</span></p>
  ${jev([f])}
  <p>${f.message}</p>
  ${f.helpUri ? html`<p class="small">${link(f.helpUri, 'Rule documentation')}</p>` : undefined}
  ${code(f, codeOf)}
</article>`,
  );
  return html`<section>
  <h2>To fix, per Jev <span class="count">${fix.length}</span></h2>
  <p class="muted">Findings Jev judged real, most certain first.</p>
  ${items.length ? items : html`<p>Nothing: Jev judged no finding real.</p>`}
</section>`;
}

function group(g: Finding[], codeOf?: CodeOf): Html {
  const f = g[0] as Finding;
  const s = status(f);
  const why = f.decision && f.decision.action !== 'fix' ? html`<p class="decision">Decided: ${f.decision.reason}${f.decision.ref ? html` (${link(f.decision.ref, f.decision.ref)})` : undefined}</p>` : undefined;
  const locations = g.map((x, i) => html`<li><code>${where(x)}</code> <span class="muted">${x.id}${x.isNew ? '' : ' · pre-existing'}</span>${i < MAX_EXCERPTS_PER_GROUP ? code(x, codeOf) : undefined}</li>`);
  const open = s.tone === 'block' || g.length <= 2;
  return html`<details class="finding ${s.tone}" ${open ? html`open` : undefined}>
  <summary>${pill(s.tone, s.label)} <b>${ruleKey(f)}</b> <span class="muted">· ${f.severity} · ${g.length} location${g.length === 1 ? '' : 's'}</span></summary>
  <p>${f.message}</p>
  ${f.helpUri ? html`<p class="small">${link(f.helpUri, 'Rule documentation')}</p>` : undefined}
  ${jev(g)}${why}
  <ul class="locations">${locations}</ul>
</details>`;
}

function findingSections(r: Review, codeOf?: CodeOf): Html[] {
  return CATEGORIES.flatMap((category) => {
    const inCategory = r.findings.filter((f) => f.category === category);
    if (inCategory.length === 0) return [];
    return [html`<section id="${category}"><h2 class="category">${category} <span class="count">${inCategory.length}</span></h2>${groupFindings(inCategory).map((g) => group(g, codeOf))}</section>`];
  });
}

function analyzerTable(r: Review): Html {
  const rows = r.analyzers.map((a) => {
    const state = a.error ? pill('block', a.error) : a.skipped ? html`<span class="muted">${a.skipped}</span>` : 'ran';
    return html`<tr><td>${a.name}</td><td class="num">${a.files}</td><td class="num">${a.findings}</td><td class="num">${(a.durationMs / 1000).toFixed(1)} s</td><td class="small">${state}</td></tr>`;
  });
  return html`<details><summary>Analyzers (${r.analyzers.length})</summary><table><thead><tr><th>Analyzer</th><th class="num">Files</th><th class="num">Findings</th><th class="num">Time</th><th>State</th></tr></thead><tbody>${rows}</tbody></table></details>`;
}

function notes(r: Review): Html | undefined {
  if (r.notes.length === 0) return undefined;
  return html`<details><summary>Notes (${r.notes.length})</summary><ul>${r.notes.map((n) => html`<li>${n}</li>`)}</ul></details>`;
}

const CSS = new Html(`
:root{--bg:#fbfaf8;--fg:#1d1d1f;--muted:#6b6b70;--card:#fff;--line:#e4e2dd;--code:#f3f1ec;--hit:#fff3c4;
--block:#b42318;--block-bg:#fde8e6;--warn:#9a5b00;--warn-bg:#fdf1dc;--ok:#1f7a3f;--ok-bg:#e3f4e8;--info:#45506b;--info-bg:#e9edf5;--todo:#5b3cc4;--todo-bg:#ece7fb}
@media (prefers-color-scheme:dark){:root{--bg:#141415;--fg:#ececee;--muted:#9a9aa2;--card:#1c1c1e;--line:#2e2e32;--code:#222225;--hit:#4a3d0f;
--block:#ff8a80;--block-bg:#3b1715;--warn:#f5b955;--warn-bg:#382810;--ok:#7ad99a;--ok-bg:#143020;--info:#a9b6d6;--info-bg:#1f2533;--todo:#b8a6ff;--todo-bg:#272040}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1000px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:26px;margin:4px 0 8px}h2{font-size:19px;margin:36px 0 12px}h2.category{text-transform:capitalize}h3{font-size:16px;margin:0 0 6px}
a{color:inherit}code,pre{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--code);border-radius:8px;padding:10px 12px;overflow-x:auto;margin:8px 0}.hit{background:var(--hit);display:inline-block;min-width:100%}
.eyebrow{margin:0;color:var(--muted);font-size:13px}.muted{color:var(--muted)}.small{font-size:13px}.num{text-align:right}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{padding:8px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:13px;color:var(--muted);font-weight:600}
.pill{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;vertical-align:middle;white-space:nowrap}
.pill.block{color:var(--block);background:var(--block-bg)}.pill.warn{color:var(--warn);background:var(--warn-bg)}.pill.ok{color:var(--ok);background:var(--ok-bg)}
.pill.info{color:var(--info);background:var(--info-bg)}.pill.todo{color:var(--todo);background:var(--todo-bg)}
.count{font-size:13px;color:var(--muted);font-weight:500}
.card,.finding{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
.finding.block{border-left:4px solid var(--block)}.finding.warn{border-left:4px solid var(--warn)}.finding.ok{border-left:4px solid var(--ok)}.finding.todo{border-left:4px solid var(--todo)}
summary{cursor:pointer}.finding p{margin:8px 0}.locations{padding-left:18px}.locations li{margin:6px 0}
.n{display:inline-block;width:22px;height:22px;border-radius:50%;background:var(--code);text-align:center;font-size:13px;line-height:22px;margin-right:4px}
.jev{font-size:13px}.meter{display:inline-block;width:70px;height:6px;border-radius:3px;background:var(--line);vertical-align:middle;margin-right:4px;overflow:hidden}
.meter span{display:block;height:100%}.meter.block span{background:var(--block)}.meter.warn span{background:var(--warn)}.meter.ok span{background:var(--ok)}
.w0{width:3%}.w1{width:10%}.w2{width:20%}.w3{width:30%}.w4{width:40%}.w5{width:50%}.w6{width:60%}.w7{width:70%}.w8{width:80%}.w9{width:90%}.w10{width:100%}
.decision{font-size:13px;color:var(--ok)}details>summary{font-weight:500}main>details{margin-top:24px}`);

function page(title: string, body: Part): string {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`.value;
}

/** One review as a page a person can read: verdicts, the fix list, every finding with its code. */
export function reviewHtml(r: Review, codeOf?: CodeOf): string {
  return page(`Review ${r.id}`, [header(r), categoryTable(r), fixList(r, codeOf), findingSections(r, codeOf), analyzerTable(r), notes(r)]);
}

/** What the report list shows of a review; also what the report store keeps beside the page. */
export interface ReportMeta {
  id: string;
  repoRoot: string;
  scope: 'diff' | 'all';
  base: string;
  blocking: number;
  findings: number;
  /** When the report store took it (ms); absent for a review only in memory. */
  storedAt?: number;
}

export function metaOf(r: Review): ReportMeta {
  return { id: r.id, repoRoot: r.repoRoot, scope: r.scope, base: r.base, blocking: r.blocking, findings: r.findings.length };
}

/** Reviews in memory (newest last) and stored reports (newest first) as one list, newest first, each once. */
export function mergeReports(inMemory: Review[], stored: ReportMeta[]): ReportMeta[] {
  const memory = [...inMemory].reverse().map(metaOf);
  const seen = new Set(memory.map((m) => m.id));
  return [...memory, ...stored.filter((m) => !seen.has(m.id))];
}

/**
 * The recent reviews, newest first; `missing` names a review that was asked for and is not among them.
 * `ttlDays`: reports are kept by the report store for that long; without it they live in memory only.
 */
export function reportIndexHtml(reports: ReportMeta[], missing?: string, ttlDays?: number): string {
  const rows = reports.map((r) => {
    const verdict = r.blocking > 0 ? pill('block', `${r.blocking} blocking`) : pill('ok', 'Passed');
    const scope = r.scope === 'all' ? 'whole repo' : `vs ${r.base}`;
    return html`<tr><td><a href="/reports/${r.id}"><code>${r.id}</code></a></td><td>${verdict}</td><td class="num">${r.findings}</td><td class="small"><code>${r.repoRoot}</code><br>${scope}</td></tr>`;
  });
  const table = rows.length
    ? html`<table><thead><tr><th>Review</th><th>Verdict</th><th class="num">Findings</th><th>Repository</th></tr></thead><tbody>${rows}</tbody></table>`
    : html`<p>No reviews yet. Run <code>run_review</code> from your harness.</p>`;
  const kept = ttlDays ? `Kept ${ttlDays} days, then deleted.` : 'Kept in memory; a gateway restart clears this list.';
  const gone = ttlDays ? `It may be older than ${ttlDays} days.` : 'It may be older than the last 20 reviews or from before a restart.';
  const notFound = missing ? html`<p>${pill('block', `${missing} not found`)} ${gone}</p>` : undefined;
  return page('Code review reports', [html`<header><p class="eyebrow">multi-code-review</p><h1>Recent reviews</h1>${notFound}<p class="muted">${kept}</p></header>`, table]);
}

/** What the report store gave for one request: its list, the stored page asked for, its TTL. */
export interface Stored {
  reports: ReportMeta[];
  page?: string;
  ttlDays?: number;
}

/**
 * The response for GET /reports (recent reviews, newest first) or /reports/R-xxxxxxxx.
 * Reports show code, so the Host header must be an allowed one (DNS rebinding): else 403 with no body.
 */
export function reportResponse(
  url: string,
  host: string | undefined,
  allowedHosts: string[],
  reviews: Map<string, Review>,
  codeOf: (r: Review) => CodeOf,
  stored: Stored = { reports: [] },
): { status: number; body?: string } {
  if (!host || !allowedHosts.includes(host)) return { status: 403 };
  const all = mergeReports([...reviews.values()], stored.reports);
  if (url === '/reports') return { status: 200, body: reportIndexHtml(all, undefined, stored.ttlDays) };
  const id = url.slice('/reports/'.length);
  const review = reviews.get(id);
  if (review) return { status: 200, body: reviewHtml(review, codeOf(review)) };
  // Not in memory (older, or from before a restart): the page as stored right after the review.
  if (stored.page) return { status: 200, body: stored.page };
  return { status: 404, body: reportIndexHtml(all, id, stored.ttlDays) };
}

/** Is this a report URL the gateway answers, and which review does it name? */
export function reportId(url: string): string | undefined {
  const id = url.slice('/reports/'.length);
  return url.startsWith('/reports/') && /^R-[0-9a-f]{8}$/.test(id) ? id : undefined;
}
