// One review: diff (or whole repo) -> pick analyzers -> run in parallel ->
// classify -> apply the repo's decisions -> report.

import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { analyze, filesFor, infoOf, type Analyzer, type AnalyzerInfo } from './analyzers.ts';
import { MODEL_TOOLS, type Profile } from './catalog.ts';
import { applyAssessment, codeAround, findingRequest, tierFrom, tierRequest, toJudge, type Ask, type DiffSummary, type Tier } from './judge.ts';
import { pool } from './jev.ts';
import { blocks, defaultLevels, levelsLine, parseSettings, runs, shown, SETTINGS_FILE, type Levels } from './settings.ts';
import { detect, missingProfiles } from './detect.ts';
import { applyDecisions, DECISIONS_FILE, parseDecisions, type Decision } from './decisions.ts';
import { CATEGORIES, classify, dedupe, fromSarif, sortFindings, toolOf, uniqueIds, type Category, type Finding } from './findings.ts';
import { changes, cloudTemplates, everything, resolveRepo, type Change } from './git.ts';

export type Scope = 'diff' | 'all';

export interface ReviewOptions {
  path: string;
  base?: string;
  /** diff: what changed since the merge base (default). all: every file, for a baseline triage. */
  scope?: Scope;
  analyzers?: string[];
  categories?: Category[];
  /** Also return findings on unchanged lines of changed files. They never block. */
  includePreexisting?: boolean;
  /** Profiles running, to point out stacks in the diff that have no analyzers up. */
  profiles?: Profile[];
  /** A System One model for typed judgments (Jev); without it the rules decide alone. */
  judge?: { ask: Ask; model: string };
  /** Levels for repos without .mcr/settings.yml (MCR_LEVELS). */
  defaultLevels?: Levels;
  today: string;
}

export interface AnalyzerRun {
  name: string;
  category?: string;
  files: number;
  findings: number;
  durationMs: number;
  error?: string;
  skipped?: string;
}

export interface Review {
  id: string;
  scope: Scope;
  repoRoot: string;
  base: string;
  mergeBase: string;
  head: string;
  changedFiles: number;
  /** Files at least one analyzer looked at. */
  analyzedFiles: string[];
  analyzers: AnalyzerRun[];
  findings: Finding[];
  preexisting: number;
  blocking: number;
  /** Hidden by `disable` decisions. */
  suppressed: number;
  decisions: Decision[];
  /** Decision ids that matched a finding in this review, including pre-existing ones. */
  decisionsUsed: string[];
  /** trivial diffs skip the LLM reviewers; set by the judge model or by size and paths. */
  tier: Tier;
  /** How hard each category was reviewed (.mcr/settings.yml). */
  levels: Levels;
  /** Findings below their category's level, not listed. */
  belowLevel: number;
  /** Findings the judge model assessed. */
  judged: number;
  notes: string[];
}

export function readLines(repoRoot: string): (file: string, line: number) => string {
  const cache = new Map<string, string[]>();
  return (file, line) => {
    if (!cache.has(file)) {
      try {
        cache.set(file, readFileSync(join(repoRoot, file), 'utf8').split('\n'));
      } catch {
        cache.set(file, []);
      }
    }
    return cache.get(file)?.[line - 1] ?? '';
  };
}

/** Flagged lines shown per finding in an excerpt. */
const MAX_FLAGGED_LINES = 12;

/**
 * The code around a finding for a fix list: ±radius lines, flagged lines marked with >>.
 * Files outside the repo (by path or symlink), or a repo that is gone, give nothing.
 */
export function codeExcerpts(repoRoot: string, radius = 6): (f: Finding) => string {
  const cache = new Map<string, string[]>();
  let root: string;
  try {
    root = realpathSync(repoRoot);
  } catch {
    return () => '';
  }
  return (f) => {
    if (!cache.has(f.file)) {
      try {
        const real = realpathSync(resolve(root, f.file));
        if (real !== root && !real.startsWith(root + sep)) throw new Error('outside the repository');
        cache.set(f.file, readFileSync(real, 'utf8').split('\n'));
      } catch {
        cache.set(f.file, []);
      }
    }
    const lines = cache.get(f.file) ?? [];
    if (!lines.length) return '';
    // A finding over a whole function shows its start, not all of it.
    const end = Math.min(f.endLine, f.line + MAX_FLAGGED_LINES - 1);
    const text = codeAround(end < f.endLine ? lines.slice(0, end) : lines, f.line, end, radius);
    return end < f.endLine ? `${text}\n   …  ${f.endLine - end} more flagged lines, to ${f.endLine}` : text;
  };
}

export function loadDecisions(repoRoot: string): { decisions: Decision[]; notes: string[] } {
  let text: string | undefined;
  try {
    text = readFileSync(join(repoRoot, DECISIONS_FILE), 'utf8');
  } catch {
    text = undefined;
  }
  return parseDecisions(text);
}

/** "a: msg" and "b: msg" become "a, b: msg": containers sharing a tool repeat its notes. */
export function collapseNotes(notes: string[]): string[] {
  const byText = new Map<string, string[]>();
  for (const note of notes) {
    const m = /^([a-z0-9-]+): (.*)$/s.exec(note);
    const [who, text] = m ? [m[1] as string, m[2] as string] : ['', note];
    byText.set(text, [...(byText.get(text) ?? []), who]);
  }
  return [...byText.entries()].map(([text, who]) => (who.some(Boolean) ? `${who.filter(Boolean).sort().join(', ')}: ${text}` : text));
}

function isInfo(i: AnalyzerInfo | { name: string; error: string }): i is AnalyzerInfo {
  return !('error' in i);
}

export async function runReview(registry: Analyzer[], mcrRoot: string, opts: ReviewOptions): Promise<Review> {
  const repoRoot = await resolveRepo(opts.path, mcrRoot);
  const scope: Scope = opts.scope ?? 'diff';
  const change: Change = scope === 'all' ? await everything(repoRoot) : await changes(repoRoot, opts.base);
  const selected = opts.analyzers?.length ? registry.filter((a) => opts.analyzers?.includes(a.name)) : registry;
  const unknown = (opts.analyzers ?? []).filter((n) => !registry.some((a) => a.name === n));
  const notes: string[] = unknown.map((n) => `unknown analyzer: ${n}`);
  const readLine = readLines(repoRoot);
  const analyzed = new Set<string>();
  if (opts.profiles) {
    const missing = missingProfiles(detect(change.files, undefined, cloudTemplates(repoRoot, change.files)), opts.profiles);
    if (missing.length) notes.push(`this change has code for the ${missing.join(', ')} profile(s), which are not running: run ./setup.sh to start them`);
  }

  const summary: DiffSummary = {
    files: change.files.map((f) => {
      const l = change.lines.get(f);
      return { path: f, changedLines: l === 'all' || l === undefined ? 'new file' : l.reduce((n, [a, b]) => n + b - a + 1, 0) };
    }),
    totalChangedLines: 0,
  };
  summary.totalChangedLines = summary.files.reduce((n, f) => n + (f.changedLines === 'new file' ? 50 : f.changedLines), 0);
  let tier: Tier = scope === 'all' ? 'full' : 'lite';
  if (scope === 'diff') {
    let answer;
    if (opts.judge) {
      try {
        answer = (await opts.judge.ask(tierRequest(summary))).risk;
      } catch (e) {
        notes.push(`judge: risk tier by rules (${(e as Error).message})`);
      }
    }
    tier = tierFrom(summary, answer);
  }

  let settingsText: string | undefined;
  try {
    settingsText = readFileSync(join(repoRoot, SETTINGS_FILE), 'utf8');
  } catch {
    settingsText = undefined;
  }
  const settings = parseSettings(settingsText, opts.defaultLevels ?? defaultLevels().levels);
  const levels = settings.levels;
  notes.push(...settings.notes);

  const results = await Promise.all(
    selected.map(async (a): Promise<{ run: AnalyzerRun; findings: Finding[] }> => {
      const started = Date.now();
      const named = CATEGORIES.find((c) => a.name.startsWith(`${c}-`));
      const model = MODEL_TOOLS.has(toolOf(a.name));
      if (named && !runs(levels[named], model, tier === 'trivial')) {
        const why = levels[named] === 'off' ? 'category off' : levels[named] === 'minimum' ? 'level minimum: analyzers only' : 'trivial change';
        return { run: { name: a.name, category: named, files: 0, findings: 0, durationMs: 0, skipped: why }, findings: [] };
      }
      const info = await infoOf(a);
      // Before /info answers, the <category>-<tool> name is the best guess of the category.
      const guess = CATEGORIES.find((c) => a.name.startsWith(`${c}-`));
      if (!isInfo(info)) return { run: { name: a.name, category: guess, files: 0, findings: 0, durationMs: 0, error: info.error }, findings: [] };
      const category = info.category ?? guess;
      const files = filesFor(info, change.files);
      if (files.length === 0) {
        return { run: { name: a.name, category, files: 0, findings: 0, durationMs: 0, skipped: 'no matching files' }, findings: [] };
      }
      try {
        const changes = Object.fromEntries(files.map((f) => [f, change.lines.get(f) ?? 'all']));
        const sarif = await analyze(a, repoRoot, files, changes);
        files.forEach((f) => analyzed.add(f));
        const parsed = fromSarif(a.name, sarif as Parameters<typeof fromSarif>[1]);
        notes.push(...parsed.notes);
        const findings = parsed.findings
          .filter((f) => change.lines.has(f.file)) // project-wide tools (tsc) report outside the diff
          .map((f) => classify(f, change.lines.get(f.file), readLine(f.file, f.line)))
          .map((f) => ({ ...f, blocking: f.isNew && blocks(levels[f.category], f.severity) }));
        return { run: { name: a.name, category, files: files.length, findings: findings.length, durationMs: Date.now() - started }, findings };
      } catch (e) {
        return { run: { name: a.name, category, files: files.length, findings: 0, durationMs: Date.now() - started, error: (e as Error).message }, findings: [] };
      }
    }),
  );

  const loaded = loadDecisions(repoRoot);
  notes.push(...loaded.notes);
  const applied = applyDecisions(uniqueIds(dedupe(results.flatMap((r) => r.findings))), loaded.decisions, opts.today);
  notes.push(...applied.notes);

  const visible = applied.findings.filter((f) => shown(levels[f.category], f.severity));
  const belowLevel = applied.findings.length - visible.length;
  if (settingsText !== undefined || opts.defaultLevels) notes.push(`levels: ${levelsLine(levels)}`);
  let all = visible;
  let judged = 0;
  if (opts.judge) {
    const judge = opts.judge;
    const picked = new Set(toJudge(all));
    const lines = new Map<string, string[]>();
    const linesOf = (file: string) => {
      if (!lines.has(file)) {
        try {
          lines.set(file, readFileSync(join(repoRoot, file), 'utf8').split('\n'));
        } catch {
          lines.set(file, []);
        }
      }
      return lines.get(file) ?? [];
    };
    let failed = 0;
    all = await pool(all, 8, async (f) => {
      if (!picked.has(f)) return f;
      try {
        const answers = await judge.ask(findingRequest(f, codeAround(linesOf(f.file), f.line, f.endLine), loaded.decisions));
        judged++;
        return applyAssessment(f, answers, judge.model);
      } catch {
        failed++;
        return f;
      }
    });
    if (failed) notes.push(`judge: ${failed} finding(s) not assessed (model unavailable); the rules decided`);
  }
  if (opts.categories?.length) all = all.filter((f) => opts.categories?.includes(f.category));
  const preexisting = all.filter((f) => !f.isNew).length;
  const findings = sortFindings(opts.includePreexisting ? all : all.filter((f) => f.isNew));

  return {
    id: `R-${randomUUID().slice(0, 8)}`,
    scope,
    repoRoot,
    base: change.base,
    mergeBase: change.mergeBase,
    head: change.head,
    changedFiles: change.files.length,
    analyzedFiles: [...analyzed].sort(),
    analyzers: results.map((r) => r.run),
    findings,
    preexisting,
    blocking: findings.filter((f) => f.blocking).length,
    suppressed: applied.suppressed,
    decisions: loaded.decisions,
    decisionsUsed: [...applied.used].sort(),
    tier,
    levels,
    belowLevel,
    judged,
    notes: collapseNotes(notes),
  };
}
