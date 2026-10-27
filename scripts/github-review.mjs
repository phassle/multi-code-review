// A review as a GitHub pull request review: a summary body plus one comment on
// the line of each new finding, P1 (blocks) / P2 (warn) / P3 (info). The body
// for POST /repos/{owner}/{repo}/pulls/{n}/reviews. Pure.

export const MARKER = '<!-- multi-code-review -->';
const CATEGORIES = ['security', 'architecture', 'best-practices', 'testing', 'correctness', 'reliability'];
const MAX_INLINE = 30;
const MAX_BODY = 60_000;
const BADGE = { P1: 'e05d44', P2: 'dfb317', P3: '9f9f9f' };

export function priority(f) {
  if (f.blocking) return 'P1';
  return f.severity === 'low' ? 'P3' : 'P2';
}

/** Shown on the PR: new, and not accepted or called a false positive by a team decision. */
export function commentable(f) {
  return f.isNew && f.decision?.action !== 'accept' && f.decision?.action !== 'false-positive';
}

/** The first sentence as a title, the rest as the text. */
export function titleAndText(message) {
  const all = message.trim();
  const m = /^(.+?[.!?:])(?:\s+([\s\S]*))?$/s.exec(all);
  const first = (m ? m[1] : all.split('\n')[0]).replace(/\s+/g, ' ').replace(/[.:]$/, '');
  const rest = (m ? (m[2] ?? '') : all.split('\n').slice(1).join('\n')).trim();
  if (first.length > 140) return { title: `${first.slice(0, 137)}…`, text: all };
  return { title: first, text: rest };
}

/** Lines on the new side of each file's patch, from GET /pulls/{n}/files: a comment must sit on one of them. */
export function commentableLines(prFiles) {
  const out = new Map();
  for (const f of prFiles) {
    const ranges = [];
    for (const h of (f.patch ?? '').matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      if (count > 0) ranges.push([start, start + count - 1]);
    }
    out.set(f.filename, ranges);
  }
  return out;
}

/** The line to comment on: the finding's first line in the diff, or undefined. Without PR files, its own line. */
export function anchor(f, lines) {
  if (!lines) return f.line;
  const ranges = lines.get(f.file);
  if (!ranges) return undefined;
  for (let l = f.line; l <= Math.max(f.line, f.endLine ?? f.line); l++) if (ranges.some(([a, b]) => l >= a && l <= b)) return l;
  return undefined;
}

function badge(p) {
  return `![${p}](https://img.shields.io/badge/${p}-${BADGE[p]}?style=flat-square)`;
}

/** tool:ruleId, the key decisions use: the container's category prefix dropped (findings.ts toolOf). */
export function ruleOf(f) {
  const category = CATEGORIES.find((c) => f.analyzer.startsWith(`${c}-`));
  return `${category ? f.analyzer.slice(category.length + 1) : f.analyzer}:${f.ruleId}`;
}

export function commentBody(f) {
  const { title, text } = titleAndText(f.message);
  const meta = [`\`${ruleOf(f)}\``, f.category, f.severity];
  if (f.assessment) meta.push(`Jev p(real) ${f.assessment.pReal.toFixed(2)}`);
  if (f.decision?.action === 'fix') meta.push(`to fix ${f.decision.id}`);
  if (f.helpUri) meta.push(`[rule](${f.helpUri})`);
  return [
    `<!-- mcr:${f.fingerprint} -->`,
    `${badge(priority(f))} **${title}**`,
    ...(text ? ['', text] : []),
    '',
    `<sub>${meta.join(' · ')} · ${f.id}</sub>`,
    '',
    '<sub>Disagree? Record a team decision (accept, false-positive, disable) with `triage_queue`. Useful? React with 👍 / 👎.</sub>',
  ].join('\n');
}

/** From the compact review, so pre-existing and accepted findings count too. */
function categoryRows(review) {
  const rows = ['| Category | Verdict | Findings |', '|---|---|---|'];
  for (const c of CATEGORIES) {
    const runs = review.analyzers.filter((a) => a.name.startsWith(`${c}-`));
    const inC = review.findings.filter((f) => f.category === c);
    const blocking = inC.filter((f) => f.blocking).length;
    const failed = runs.filter((a) => a.error);
    let verdict;
    if (blocking) verdict = `⛔ ${blocking} blocking`;
    else if (failed.length) verdict = `❌ ${failed.map((a) => a.name).join(', ')} failed`;
    else if (inC.some((f) => !f.preexisting && !/^(accept|false-positive) /.test(f.decision ?? '') && f.severity !== 'low')) verdict = '⚠️ warn';
    else if (runs.length === 0) verdict = '➖ not checked';
    else verdict = '✅ pass';
    rows.push(`| ${c} | ${verdict} | ${inC.length} |`);
  }
  return rows;
}

/** Where a later step may add the HTML report link: `· [HTML](url)`. */
export const HTML_LINK_MARKER = '<!-- mcr:html-link -->';

function reportLinks({ reportUrl, htmlUrl }) {
  const links = [];
  if (reportUrl) links.push(`📄 **[Full report](${reportUrl})**: every finding with its code`);
  if (htmlUrl) links.push(`[HTML](${htmlUrl})`);
  return links.join(' · ') + (htmlUrl ? '' : HTML_LINK_MARKER);
}

/**
 * review: compactReview JSON from run_review; findings: full findings (get_finding) for it.
 * opts: { commit, prFiles?, reportUrl?, htmlUrl?, skip?: Set of fingerprints already commented }.
 * reportUrl: a page with the full report (the workflow run, whose summary has it);
 * htmlUrl: the HTML report. Without htmlUrl the body keeps HTML_LINK_MARKER where a
 * later step can put it (the workflow uploads the HTML after this is written).
 */
export function githubReview(review, findings, opts = {}) {
  const lines = opts.prFiles ? commentableLines(opts.prFiles) : undefined;
  const order = { P1: 0, P2: 1, P3: 2 };
  const shown = findings.filter(commentable).sort((a, b) => order[priority(a)] - order[priority(b)] || a.file.localeCompare(b.file) || a.line - b.line);
  const comments = [];
  const offDiff = [];
  let already = 0;
  for (const f of shown) {
    if (opts.skip?.has(f.fingerprint)) {
      already++;
      continue;
    }
    const line = anchor(f, lines);
    if (line === undefined || comments.length >= MAX_INLINE) offDiff.push(f);
    else comments.push({ path: f.file, line, side: 'RIGHT', body: commentBody(f) });
  }
  const count = (p) => shown.filter((f) => priority(f) === p).length;
  const verdict = review.blocking > 0 ? `⛔ **${review.blocking} blocking**` : '✅ **Nothing blocks**';
  const counts = [`P1 ${count('P1')}`, `P2 ${count('P2')}`, `P3 ${count('P3')}`].join(' · ');
  const body = [
    MARKER,
    '## 🔍 Multi Code Review',
    '',
    `${verdict} · ${counts}`,
    ...(opts.reportUrl || opts.htmlUrl ? ['', reportLinks(opts)] : []),
    '',
    `**Reviewed commit:** \`${(opts.commit ?? review.head).slice(0, 10)}\` against \`${review.base}\` · ${review.changedFiles} changed files`,
    '',
    ...categoryRows(review),
  ];
  if (offDiff.length) {
    body.push('', `**Not on a diff line** (${offDiff.length})`, '');
    for (const f of offDiff) body.push(`- ${badge(priority(f))} \`${f.file}:${f.line}\` **${titleAndText(f.message).title}** · \`${ruleOf(f)}\``);
  }
  if (already) body.push('', `<sub>${already} finding(s) already commented on an earlier commit are not repeated.</sub>`);
  const failed = review.analyzers.filter((a) => a.error);
  if (failed.length) body.push('', ...failed.map((a) => `- ❌ ${a.name}: ${a.error}`));
  body.push(
    '',
    '<details><summary>ℹ️ About Multi Code Review</summary>',
    '',
    'Static analyzers per category, optionally an LLM reviewer and Jev as judge. **P1** blocks the merge, **P2** is a warning, **P3** is information.',
    'Team decisions live in `.mcr/decisions.yml` in this repo: accepted findings are not commented again.',
    `Review \`${review.id}\`.`,
    '',
    '</details>',
  );
  let text = body.join('\n');
  if (text.length > MAX_BODY) text = `${text.slice(0, MAX_BODY)}\n\n… cut; see the full report.`;
  return { ...(opts.commit ? { commit_id: opts.commit } : {}), event: 'COMMENT', body: text, comments };
}
