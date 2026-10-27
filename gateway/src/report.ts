// Reviews as Markdown for the harness and for PR comments. Pure.

import { matchGlob, ruleKey, triageGroups, type Decision, type TriageGroup } from './decisions.ts';
import { CATEGORIES, toolOf, type Finding } from './findings.ts';
import type { Review } from './review.ts';

const MAX_PER_CATEGORY = 25;
/** Locations listed per rule group in the Markdown; the rest are counted. */
const MAX_LOCATIONS = 10;
/** Fix items shown in full (code included); the rest are one line each. */
const MAX_FIX_DETAIL = 15;

function mark(f: Finding): string {
  if (f.decision?.action === 'accept') return `✔️ accepted ${f.decision.id}`;
  if (f.decision?.action === 'false-positive') return `✔️ false positive ${f.decision.id}`;
  if (f.blocking) return f.decision ? `⛔ blocking, to fix ${f.decision.id}` : '⛔ blocking';
  if (f.decision?.action === 'fix') return `📋 to fix ${f.decision.id}`;
  return f.severity === 'low' ? 'ℹ️ info' : '⚠️ warn';
}

/** Findings with the same rule, message, mark and age, in order: one report line each. */
export function groupFindings(findings: Finding[]): Finding[][] {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = [mark(f), ruleKey(f), f.message, f.isNew, f.decision?.id ?? ''].join('\u0000');
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.values()];
}

export interface JevSummary {
  lo: number;
  hi: number;
  /** "0.05" or "0.05–0.17". */
  range: string;
  /** "likely false positive/unsure". */
  verdicts: string;
  /** A blocking finding Jev doubts: security keeps blocking whatever Jev says, so a person decides. */
  humanDecides: boolean;
  /** How many of the group Jev judged, of how many: the score covers only those judged. */
  judged: number;
  total: number;
}

/** How a decided finding is introduced in the report. */
const DECISION_LABEL = { fix: 'To fix', accept: 'Breaks the norm on purpose', 'false-positive': 'False positive', disable: 'Rule disabled' } as const;

const VERDICT_LABEL = { real: 'real', 'likely-false-positive': 'likely false positive', speculative: 'speculative', unsure: 'unsure' } as const;

/** Jev's view of a group of findings: P(real) (a range when they differ) and the verdicts; undefined when Jev judged none. */
export function jevSummary(g: Finding[]): JevSummary | undefined {
  const judged = g.filter((f) => f.assessment);
  if (judged.length === 0) return undefined;
  const ps = judged.map((f) => f.assessment?.pReal ?? 0);
  const lo = Math.min(...ps);
  const hi = Math.max(...ps);
  return {
    lo,
    hi,
    range: lo.toFixed(2) === hi.toFixed(2) ? lo.toFixed(2) : `${lo.toFixed(2)}–${hi.toFixed(2)}`,
    verdicts: [...new Set(judged.map((f) => VERDICT_LABEL[f.assessment?.verdict ?? 'unsure']))].join('/'),
    humanDecides: g.some((f) => f.blocking && f.assessment?.verdict === 'likely-false-positive'),
    judged: judged.length,
    total: g.length,
  };
}

function jevTag(g: Finding[]): string {
  const j = jevSummary(g);
  if (!j) return '';
  const partial = j.judged < j.total ? ` (judged ${j.judged} of ${j.total})` : '';
  return ` · _Jev${partial}: p(real) ${j.range}, ${j.verdicts}${j.humanDecides ? '; a human decides' : ''}_`;
}

/** What Jev judged real and nobody has accepted or dismissed: the fix list, most certain first. */
export function jevFixList(findings: Finding[]): Finding[] {
  return findings
    .filter((f) => f.assessment?.verdict === 'real' && (!f.decision || f.decision.action === 'fix'))
    .sort((a, b) => (b.assessment?.pReal ?? 0) - (a.assessment?.pReal ?? 0));
}

/** The code around a finding, flagged lines marked with >>; supplied by the caller (I/O). */
export type CodeOf = (f: Finding) => string;

/** One fix item with everything an agent needs to fix it without asking: where, what, why, the code, and how to check. */
function fixItem(f: Finding, n: number, codeOf?: CodeOf): string[] {
  const lines = [
    '',
    `#### ${n}. \`${f.id}\` ${ruleKey(f)} · ${f.category} · ${f.severity} · p(real) ${f.assessment?.pReal.toFixed(2)}`,
    '',
    `- **Where:** \`${where(f)}\``,
    `- **Problem:** ${f.message.replace(/\s*\n\s*/g, ' ')}`,
  ];
  if (f.helpUri) lines.push(`- **Reference:** ${f.helpUri}`);
  if (f.decision?.action === 'fix') lines.push(`- **Decided:** fix (${f.decision.id}): ${f.decision.reason}`);
  const code = codeOf?.(f);
  if (code) lines.push('- **Code:**', '', '````', code, '````', '');
  lines.push(`- **Done when:** \`run_analyzer\` with \`["${f.analyzer}"]\` no longer reports \`${f.ruleId}\` here. If the fix is wrong for this code, triage it instead.`);
  return lines;
}

/** The fix list as Markdown; empty when Jev did not run. */
function jevFixSection(findings: Finding[], codeOf?: CodeOf): string[] {
  if (!findings.some((f) => f.assessment)) return [];
  const fix = jevFixList(findings);
  if (fix.length === 0) return ['', '### To fix, per Jev (0)', '', '- Nothing: Jev judged no finding real.'];
  const rest = fix.slice(MAX_FIX_DETAIL).map((f) => `- \`${f.id}\` ${ruleKey(f)} at \`${where(f)}\` (p(real) ${f.assessment?.pReal.toFixed(2)}): details with \`get_finding\``);
  return ['', `### To fix, per Jev (${fix.length})`, '', 'Findings Jev judged real, most certain first. Each has what an agent needs to fix it.', ...fix.slice(0, MAX_FIX_DETAIL).flatMap((f, i) => fixItem(f, i + 1, codeOf)), ...(rest.length ? ['', ...rest] : [])];
}

export function where(f: Finding): string {
  return f.endLine > f.line ? `${f.file}:${f.line}-${f.endLine}` : `${f.file}:${f.line}`;
}

/** The line that links the readable report; the GitHub workflow rewrites it by its prefix. */
export const REPORT_LINK_PREFIX = '📄 **Full report:**';

export function reportLink(url: string): string {
  return `${REPORT_LINK_PREFIX} [${url}](${url})`;
}

function header(r: Review, title: string, reportUrl?: string): string[] {
  const scope = r.scope === 'all' ? `whole repo (${r.changedFiles} files)` : `${r.changedFiles} changed files vs \`${r.base}\` (${r.mergeBase.slice(0, 8)})`;
  return [
    `## multi-code-review: ${title}`,
    ...(reportUrl ? ['', reportLink(reportUrl)] : []),
    '',
    `Review \`${r.id}\` · \`${r.repoRoot}\` · ${scope} · ${r.findings.length} findings listed, ${r.preexisting} pre-existing, ${r.suppressed} hidden by decisions`,
  ];
}

/** One row per category: did its analyzers run, and does anything in it block? */
export function categoryTable(r: Review): string[] {
  const rows = ['| Category | Verdict | Findings | Analyzers | Time |', '|---|---|---|---|---|'];
  for (const category of CATEGORIES) {
    const runs = r.analyzers.filter((a) => a.category === category);
    const findings = r.findings.filter((f) => f.category === category);
    const blocking = findings.filter((f) => f.blocking).length;
    const failed = runs.filter((a) => a.error);
    let verdict: string;
    if (runs.length === 0) verdict = '➖ no analyzer; model review only';
    else if (blocking > 0) verdict = `⛔ ${blocking} blocking`;
    else if (failed.length > 0) verdict = `❌ ${failed.map((a) => a.name).join(', ')} failed`;
    else if (runs.every((a) => a.skipped)) verdict = '➖ nothing to check';
    else verdict = '✅ pass';
    const names = runs.map((a) => (a.skipped ? `~~${a.name}~~` : a.name)).join(', ') || '–';
    const time = runs.length ? `${(Math.max(...runs.map((a) => a.durationMs)) / 1000).toFixed(1)} s` : '–';
    rows.push(`| ${category} | ${verdict} | ${findings.length} | ${names} | ${time} |`);
  }
  return rows;
}

export function toMarkdown(r: Review, codeOf?: CodeOf, reportUrl?: string): string {
  const lines = header(r, r.blocking > 0 ? `⛔ ${r.blocking} blocking` : '✅ passed', reportUrl);
  lines.push('', ...categoryTable(r));
  const errors = r.analyzers.filter((a) => a.error);
  if (errors.length) lines.push('', ...errors.map((a) => `- ❌ ${a.name}: ${a.error}`));
  for (const category of CATEGORIES) {
    const inCategory = r.findings.filter((f) => f.category === category);
    if (inCategory.length === 0) continue;
    lines.push('', `### ${category} (${inCategory.length})`, '');
    const groups = groupFindings(inCategory);
    for (const g of groups.slice(0, MAX_PER_CATEGORY)) {
      const f = g[0] as Finding;
      const pre = f.isNew ? '' : ' (pre-existing)';
      const why = f.decision && f.decision.action !== 'fix' ? ` _${DECISION_LABEL[f.decision.action]}: ${f.decision.reason}_` : '';
      const more = g.length > MAX_LOCATIONS ? ` and ${g.length - MAX_LOCATIONS} more` : '';
      const at = g.slice(0, MAX_LOCATIONS).map((x) => `\`${where(x)}\` ${x.id}`).join(', ') + more;
      lines.push(`- ${mark(f)} **${ruleKey(f)}** at ${at}${pre}: ${f.message.split('\n')[0]}${why}${jevTag(g)}`);
    }
    if (groups.length > MAX_PER_CATEGORY) lines.push(`- … ${groups.length - MAX_PER_CATEGORY} more rules; filter with \`categories\``);
  }
  lines.push(...jevFixSection(r.findings, codeOf));
  if (r.notes.length) lines.push('', '### Notes', '', ...r.notes.slice(0, 20).map((n) => `- ${n}`));
  return lines.join('\n');
}

export function triageMarkdown(r: Review, groups: TriageGroup[]): string {
  const total = groups.reduce((n, g) => n + g.count, 0);
  const lines = header(r, `${total} undecided findings in ${groups.length} rules`);
  if (groups.length === 0) {
    lines.push('', 'Nothing to decide: every finding has a decision.');
    return lines.join('\n');
  }
  lines.push('', 'Decide one rule at a time: **fix**, **accept** (norm broken on purpose), **false-positive**, or **disable** (rule does not apply here); for this occurrence, some paths, or the whole repo.');
  groups.forEach((g, i) => {
    const block = g.blocking ? `, ${g.blocking} blocking` : '';
    lines.push('', `### ${i + 1}. \`${g.rule}\` · ${g.category} · ${g.severity} · ${g.count} finding${g.count === 1 ? '' : 's'}${block}`, '');
    for (const f of g.findings.slice(0, 5)) lines.push(`- \`${f.id}\` \`${f.file}:${f.line}\`: ${f.message}`);
    if (g.findings.length > 5) lines.push(`- … ${g.findings.length - 5} more in ${g.files.length} files`);
    if (g.suggestion) lines.push(`- 💡 ${g.suggestion}`);
  });
  return lines.join('\n');
}

export interface FixReport {
  toFix: Finding[];
  undecided: TriageGroup[];
  accepted: Array<{ decision: Decision; count: number }>;
  /** Fix decisions that matched nothing although their analyzer ran over their scope: fixed. */
  resolved: Decision[];
  /** Other decisions that matched nothing in their analyzed scope: the code changed, they can go. */
  stale: Decision[];
}

export function fixReport(r: Review): FixReport {
  const analyzed = new Set(r.analyzedFiles);
  const used = new Set(r.decisionsUsed);
  const ran = new Set(r.analyzers.filter((a) => !a.error && !a.skipped).map((a) => toolOf(a.name)));
  // A decision can only be judged unmatched when its analyzer ran over all of
  // its scope: the whole repo, or in a diff the one file of an occurrence.
  const inScope = (d: Decision) =>
    ran.has(d.match.rule.split(':')[0] ?? '') &&
    (r.scope === 'all' ||
      (d.match.fingerprint !== undefined && (d.match.paths ?? []).some((p) => [...analyzed].some((f) => matchGlob(p, f)))));
  const counts = new Map<string, number>();
  for (const f of r.findings) if (f.decision) counts.set(f.decision.id, (counts.get(f.decision.id) ?? 0) + 1);
  return {
    toFix: r.findings.filter((f) => f.decision?.action === 'fix' || (!f.decision && f.blocking)),
    undecided: triageGroups(r.findings, r.decisions),
    accepted: r.decisions
      .filter((d) => d.action === 'accept' || d.action === 'false-positive')
      .filter((d) => used.has(d.id))
      .map((d) => ({ decision: d, count: counts.get(d.id) ?? 0 })),
    resolved: r.decisions.filter((d) => d.action === 'fix' && !used.has(d.id) && inScope(d)),
    stale: r.decisions.filter((d) => d.action !== 'fix' && !used.has(d.id) && inScope(d)),
  };
}

export function fixReportMarkdown(r: Review, report: FixReport, codeOf?: CodeOf, reportUrl?: string): string {
  const lines = header(r, `${report.toFix.length} to fix, ${report.undecided.reduce((n, g) => n + g.count, 0)} undecided`, reportUrl);
  lines.push('', `### 📋 To fix (${report.toFix.length})`, '');
  if (report.toFix.length === 0) lines.push('Nothing.');
  for (const f of report.toFix) {
    const tag = f.decision ? f.decision.id : 'blocking, no decision';
    lines.push(`- [ ] \`${f.id}\` ${f.category} · ${f.severity} · **${ruleKey(f)}** at \`${where(f)}\` (${tag}): ${f.message.split('\n')[0]}`);
  }
  lines.push('', `### ❓ Needs a decision (${report.undecided.length} rules)`, '');
  if (report.undecided.length === 0) lines.push('Nothing.');
  for (const g of report.undecided) lines.push(`- \`${g.rule}\` · ${g.category} · ${g.severity} · ${g.count} in ${g.files.length} files`);
  lines.push('', `### ✔️ Accepted, breaking the norm on purpose (${report.accepted.length})`, '');
  if (report.accepted.length === 0) lines.push('Nothing.');
  for (const { decision: d, count } of report.accepted) {
    const ref = d.ref ? ` (${d.ref})` : '';
    lines.push(`- ${d.id} \`${d.match.rule}\`${d.match.paths ? ` in ${d.match.paths.join(', ')}` : ''}: ${count} here. ${d.reason}${ref}`);
  }
  lines.push('', `Hidden by \`disable\` decisions: ${r.suppressed}.`);
  if (report.resolved.length) {
    lines.push('', `### ✅ Fixed, decision can go (${report.resolved.length})`, '');
    for (const d of report.resolved) lines.push(`- ${d.id} \`${d.match.rule}\`: ${d.reason}`);
  }
  if (report.stale.length) {
    lines.push('', `### 🧹 Matched nothing, decision can go (${report.stale.length})`, '');
    for (const d of report.stale) lines.push(`- ${d.id} ${d.action} \`${d.match.rule}\`: ${d.reason}`);
  }
  lines.push(...jevFixSection(r.findings, codeOf));
  if (r.notes.length) lines.push('', '### Notes', '', ...r.notes.slice(0, 20).map((n) => `- ${n}`));
  return lines.join('\n');
}

/** The review as compact JSON for the harness: counts and one short row per finding. Messages and code are in the Markdown and in get_finding. */
export function compactReview(r: Review) {
  return {
    id: r.id, scope: r.scope, repoRoot: r.repoRoot, base: r.base, mergeBase: r.mergeBase, head: r.head,
    changedFiles: r.changedFiles, blocking: r.blocking, preexisting: r.preexisting, suppressed: r.suppressed, judged: r.judged, tier: r.tier,
    analyzers: r.analyzers.filter((a) => !a.skipped).map((a) => ({ name: a.name, findings: a.findings, ms: a.durationMs, ...(a.error ? { error: a.error } : {}) })),
    findings: r.findings.map((f) => ({
      id: f.id, rule: ruleKey(f), category: f.category, severity: f.severity, file: f.file, line: f.line,
      ...(f.endLine > f.line ? { endLine: f.endLine } : {}),
      ...(f.blocking ? { blocking: true } : {}),
      ...(f.isNew ? {} : { preexisting: true }),
      ...(f.decision ? { decision: `${f.decision.action} ${f.decision.id}` } : {}),
      ...(f.assessment ? { pReal: f.assessment.pReal, verdict: f.assessment.verdict } : {}),
    })),
    toFix: jevFixList(r.findings).map((f) => f.id),
  };
}
