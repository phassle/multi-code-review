import { describe, expect, it } from 'vitest';
import { classify } from '../src/findings.ts';
import { categoryTable, compactReview, jevFixList, toMarkdown } from '../src/report.ts';
import type { Finding } from '../src/findings.ts';
import { collapseNotes, type Review } from '../src/review.ts';

function review(over: Partial<Review>): Review {
  return {
    id: 'R-00000000', scope: 'diff', repoRoot: '/r', base: 'origin/develop', mergeBase: 'abc', head: 'def', changedFiles: 1,
    analyzedFiles: [], analyzers: [], findings: [], preexisting: 0, blocking: 0, suppressed: 0, decisions: [], decisionsUsed: [], tier: 'lite', levels: { security: 'medium', architecture: 'medium', 'best-practices': 'medium', testing: 'medium', correctness: 'medium', reliability: 'medium' }, belowLevel: 0, judged: 0, notes: [], ...over,
  };
}

function row(rows: string[], category: string): string {
  return rows.find((r) => r.startsWith(`| ${category} |`)) ?? '';
}

describe('category verdicts', () => {
  it('gives every category a row: blocking, failed, pass, or not covered by any analyzer', () => {
    const blocker = classify(
      { analyzer: 'security-semgrep', ruleId: 'eval', message: 'eval', file: 'a.ts', line: 1, endLine: 1, category: 'security', severity: 'high' },
      'all',
      'eval(x)',
    );
    const rows = categoryTable(
      review({
        analyzers: [
          { name: 'security-semgrep', category: 'security', files: 1, findings: 1, durationMs: 2000 },
          { name: 'correctness-tsc', category: 'correctness', files: 1, findings: 0, durationMs: 0, error: 'unreachable' },
          { name: 'reliability-eslint', category: 'reliability', files: 1, findings: 0, durationMs: 500 },
          { name: 'architecture-eslint', category: 'architecture', files: 0, findings: 0, durationMs: 0, skipped: 'no matching files' },
        ],
        findings: [blocker],
      }),
    );
    expect(rows).toHaveLength(2 + 6);
    expect(row(rows, 'security')).toContain('⛔ 1 blocking');
    expect(row(rows, 'correctness')).toContain('❌ correctness-tsc failed');
    expect(row(rows, 'reliability')).toContain('✅ pass');
    expect(row(rows, 'architecture')).toContain('➖ nothing to check');
    expect(row(rows, 'testing')).toContain('➖ no analyzer');
  });
});

describe('notes', () => {
  it('merges the same note from containers that share a tool', () => {
    expect(collapseNotes(['b-eslint: skipped', 'a-eslint: skipped', 'x-tsc: other', 'plain'])).toEqual(['a-eslint, b-eslint: skipped', 'x-tsc: other', 'plain']);
  });
});

describe('Jev in the report', () => {
  const base = { analyzer: 'security-semgrep', message: 'm', file: 'a.ts', line: 1, endLine: 1, category: 'security' as const, severity: 'high' as const };
  const judged = (ruleId: string, pReal: number, verdict: 'real' | 'likely-false-positive') => ({
    ...classify({ ...base, ruleId }, 'all', 'x'),
    assessment: { model: 'jev', pReal, verdict },
  });

  it('shows Jev p(real) per finding; a security finding Jev doubts still blocks and a human decides', () => {
    const fp = judged('ssrf', 0.07, 'likely-false-positive');
    const md = toMarkdown(review({ findings: [fp], blocking: 1 }));
    expect(md).toContain('⛔ blocking');
    expect(md).toContain('Jev: p(real) 0.07, likely false positive; a human decides');
  });

  it('lists what Jev judged real, most certain first, and leaves out accepted findings', () => {
    const a = judged('a', 0.62, 'real');
    const b = judged('b', 0.86, 'real');
    const accepted = { ...judged('c', 0.9, 'real'), decision: { id: 'D-0001', action: 'accept', reason: 'r' } } as Finding;
    expect(jevFixList([a, b, accepted, judged('d', 0.1, 'likely-false-positive')]).map((f) => f.ruleId)).toEqual(['b', 'a']);
    expect(toMarkdown(review({ findings: [a, b] }))).toContain('### To fix, per Jev (2)');
  });

  it('puts the report link first, clickable, with the URL visible', () => {
    const lines = toMarkdown(review({}), undefined, 'http://127.0.0.1:7700/reports/R-00000000').split('\n');
    expect(lines[2]).toBe('📄 **Full report:** [http://127.0.0.1:7700/reports/R-00000000](http://127.0.0.1:7700/reports/R-00000000)');
    expect(toMarkdown(review({}))).not.toContain('Full report');
  });

  it('gives each fix item where, what, the code and how to check it', () => {
    const f = { ...judged('eval', 0.9, 'real'), helpUri: 'https://x/eval' };
    const md = toMarkdown(review({ findings: [f] }), () => '>>    1| eval(x)');
    expect(md).toContain(`#### 1. \`${f.id}\` semgrep:eval · security · high · p(real) 0.90`);
    expect(md).toContain('- **Where:** `a.ts:1`');
    expect(md).toContain('- **Reference:** https://x/eval');
    expect(md).toContain('>>    1| eval(x)');
    expect(md).toContain('`run_analyzer` with `["security-semgrep"]` no longer reports `eval` here');
  });

  it('has no Jev section when Jev did not run', () => {
    expect(toMarkdown(review({ findings: [classify({ ...base, ruleId: 'x' }, 'all', 'x')] }))).not.toContain('per Jev');
  });
});

describe('report size', () => {
  const at = (line: number, pReal: number) => ({
    ...classify({ analyzer: 'security-semgrep', ruleId: 'ssrf', message: 'same message', file: 's.ts', line, endLine: line, category: 'security', severity: 'high' }, 'all', `x${line}`),
    assessment: { model: 'jev', pReal, verdict: 'likely-false-positive' as const },
  });

  it('lists one rule with one message once, with every location and the range of Jev scores', () => {
    const md = toMarkdown(review({ findings: [at(1, 0.05), at(2, 0.16)], blocking: 2 }));
    expect(md.match(/same message/g)).toHaveLength(1);
    expect(md).toContain('`s.ts:1`');
    expect(md).toContain('`s.ts:2`');
    expect(md).toContain('p(real) 0.05–0.16, likely false positive; a human decides');
  });

  it('keeps messages out of the JSON', () => {
    const json = compactReview(review({ findings: [at(1, 0.05)] }));
    expect(JSON.stringify(json)).not.toContain('same message');
    expect(json.findings[0]).toMatchObject({ rule: 'semgrep:ssrf', file: 's.ts', line: 1, blocking: true, pReal: 0.05 });
  });

  it('lists at most 10 locations per rule and counts the rest', () => {
    const md = toMarkdown(review({ findings: Array.from({ length: 13 }, (_, i) => at(i + 1, 0.1)) }));
    expect(md).toContain('`s.ts:10`');
    expect(md).not.toContain('`s.ts:11`');
    expect(md).toContain('and 3 more');
  });

  it('says when Jev judged only part of a group', () => {
    const { assessment: _a, ...unjudged } = at(2, 0.1);
    expect(toMarkdown(review({ findings: [at(1, 0.1), unjudged as Finding] }))).toContain('Jev (judged 1 of 2): p(real) 0.10');
    expect(toMarkdown(review({ findings: [at(1, 0.1), at(2, 0.1)] }))).toContain('Jev: p(real) 0.10');
  });

  it('introduces a decided finding by what was decided', () => {
    const fp = { ...at(1, 0.1), decision: { id: 'D-0001', action: 'false-positive', reason: 'tool is wrong' } } as Finding;
    const ok = { ...at(2, 0.1), message: 'other', decision: { id: 'D-0002', action: 'accept', reason: 'on purpose' } } as Finding;
    const md = toMarkdown(review({ findings: [fp, ok] }));
    expect(md).toContain('_False positive: tool is wrong_');
    expect(md).toContain('_Breaks the norm on purpose: on purpose_');
  });
});
