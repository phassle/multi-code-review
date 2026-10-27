// SARIF from any analyzer -> findings with a category, a severity, a stable
// fingerprint and a block/inform decision. Pure.

import { createHash } from 'node:crypto';
import type { AppliedDecision } from './decisions.ts';
import type { Assessment } from './judge.ts';
import { touchesChange } from './diff.ts';

export const CATEGORIES = ['security', 'architecture', 'best-practices', 'testing', 'correctness', 'reliability'] as const;
export type Category = (typeof CATEGORIES)[number];
export type Severity = 'high' | 'medium' | 'low';

export interface RawFinding {
  analyzer: string;
  ruleId: string;
  message: string;
  file: string;
  line: number;
  endLine: number;
  category: Category;
  severity: Severity;
  helpUri?: string;
}

export interface Finding extends RawFinding {
  id: string;
  fingerprint: string;
  isNew: boolean;
  blocking: boolean;
  /** Set when a recorded decision matched; accept and false-positive never block. */
  decision?: AppliedDecision;
  /** A System One model's judgment (Jev), when one ran: see judge.ts. */
  assessment?: Assessment;
}

/** Minimal SARIF 2.1.0 shape we read; third-party tools fill only parts of it. */
interface Sarif {
  runs?: Array<{
    tool?: { driver?: { rules?: Array<{ id?: string; helpUri?: string }> } };
    results?: Array<{
      ruleId?: string;
      level?: string;
      message?: { text?: string };
      locations?: Array<{ physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number; endLine?: number } } }>;
      properties?: { category?: string; severity?: string };
    }>;
    invocations?: Array<{ toolExecutionNotifications?: Array<{ message?: { text?: string } }> }>;
  }>;
}

const LEVEL_TO_SEVERITY: Record<string, Severity> = { error: 'high', warning: 'medium', note: 'low', none: 'low' };

function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

function isSeverity(value: unknown): value is Severity {
  return value === 'high' || value === 'medium' || value === 'low';
}

export function fromSarif(analyzer: string, sarif: Sarif): { findings: RawFinding[]; notes: string[] } {
  const findings: RawFinding[] = [];
  const notes: string[] = [];
  for (const run of sarif.runs ?? []) {
    const help = new Map((run.tool?.driver?.rules ?? []).map((r) => [r.id, r.helpUri]));
    for (const inv of run.invocations ?? []) {
      for (const n of inv.toolExecutionNotifications ?? []) if (n.message?.text) notes.push(`${analyzer}: ${n.message.text}`);
    }
    for (const r of run.results ?? []) {
      const location = r.locations?.[0]?.physicalLocation;
      const file = location?.artifactLocation?.uri?.replace(/^file:\/\//, '').replace(/^\.\//, '');
      if (!file) continue;
      const line = location?.region?.startLine ?? 1;
      const ruleId = r.ruleId ?? 'unknown';
      findings.push({
        analyzer,
        ruleId,
        message: r.message?.text ?? ruleId,
        file,
        line,
        endLine: location?.region?.endLine ?? line,
        category: isCategory(r.properties?.category) ? r.properties.category : 'best-practices',
        severity: isSeverity(r.properties?.severity) ? r.properties.severity : (LEVEL_TO_SEVERITY[r.level ?? 'warning'] ?? 'medium'),
        ...(help.get(ruleId) ? { helpUri: help.get(ruleId) } : {}),
      });
    }
  }
  return { findings, notes };
}

/**
 * The tool behind a container: security-semgrep -> semgrep. Decisions and
 * fingerprints use the tool, so renaming or splitting containers keeps them.
 */
export function toolOf(analyzer: string): string {
  const category = CATEGORIES.find((c) => analyzer.startsWith(`${c}-`));
  return category ? analyzer.slice(category.length + 1) : analyzer;
}

/**
 * Line numbers move as code is edited; the rule, the file and the flagged code
 * do not. This is what an accepted exception will match on.
 */
export function fingerprint(f: Pick<RawFinding, 'analyzer' | 'ruleId' | 'file'>, lineText: string): string {
  const code = lineText.replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(`${toolOf(f.analyzer)}\0${f.ruleId}\0${f.file}\0${code}`).digest('hex');
}

export function classify(
  raw: RawFinding,
  changed: Array<[number, number]> | 'all' | undefined,
  lineText: string,
): Finding {
  const fp = fingerprint(raw, lineText);
  const isNew = touchesChange(changed, raw.line, raw.endLine);
  return { ...raw, id: `F-${fp.slice(0, 8)}`, fingerprint: fp, isNew, blocking: isNew && raw.severity === 'high' };
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      Number(b.blocking) - Number(a.blocking) ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
}

/** Same rule on the same code reported twice (e.g. two analyzers' overlapping ranges) is one finding. */
/**
 * Identical flagged lines share a fingerprint, and so an id. The first keeps it (ids stay stable when code moves);
 * the n-th copy in line order gets one derived from the fingerprint and n, so every id in a review is unique.
 */
export function uniqueIds(findings: Finding[]): Finding[] {
  const order = [...findings].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const nth = new Map<Finding, number>();
  const seen = new Map<string, number>();
  for (const f of order) {
    const n = seen.get(f.id) ?? 0;
    seen.set(f.id, n + 1);
    nth.set(f, n);
  }
  return findings.map((f) => {
    const n = nth.get(f) ?? 0;
    return n === 0 ? f : { ...f, id: `F-${createHash('sha256').update(`${f.fingerprint}#${n}`).digest('hex').slice(0, 8)}` };
  });
}

export function dedupe(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.fingerprint}:${f.line}`;
    if (!seen.has(key)) seen.set(key, f);
  }
  return [...seen.values()];
}
