import { describe, expect, it } from 'vitest';
import { appendDecisions, applyDecisions, matchDecision, matchGlob, parseDecisions, triageGroups, type Decision } from '../src/decisions.ts';
import { classify, type Finding, type RawFinding } from '../src/findings.ts';
import { fixReport } from '../src/report.ts';
import type { Review } from '../src/review.ts';

const TODAY = '2026-10-13';

function finding(over: Partial<RawFinding> = {}, line = 'x()'): Finding {
  const raw: RawFinding = {
    analyzer: 'semgrep',
    ruleId: 'i18n',
    message: 'not internationalised',
    file: 'src/app/page.tsx',
    line: 10,
    endLine: 10,
    category: 'best-practices',
    severity: 'high',
    ...over,
  };
  return classify(raw, 'all', line);
}

function decision(over: Partial<Decision> & Pick<Decision, 'action'>): Decision {
  return { id: 'D-0001', match: { rule: 'semgrep:i18n' }, reason: 'Swedish only', decided_on: '2026-10-01', ...over };
}

describe('globs', () => {
  it('lets ** cross directories and * stay within one', () => {
    expect(matchGlob('src/**', 'src/a/b.ts')).toBe(true);
    expect(matchGlob('src/**/*.ts', 'src/a.ts')).toBe(true);
    expect(matchGlob('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(matchGlob('src/db/migrations/**', 'src/db/schema.ts')).toBe(false);
    expect(matchGlob('a.b', 'axb')).toBe(false);
  });

  it('matches like the old regex on the usual shapes', () => {
    const cases: Array<[string, string, boolean]> = [
      ['**/*.test.ts', 'a.test.ts', true],
      ['**/*.test.ts', 'x/y/a.test.ts', true],
      ['src/**/gen/*', 'src/gen/a.ts', true],
      ['src/**/gen/*', 'src/x/gen/a.ts', true],
      ['src/**/gen/*', 'src/x/gen/b/a.ts', false],
      ['src/?.ts', 'src/a.ts', true],
      ['src/?.ts', 'src/ab.ts', false],
      ['src/a.ts', 'src/a.ts', true],
      ['src/a.ts', 'src/a.tsx', false],
      ['*', 'a/b', false],
      ['**', 'a/b', true],
    ];
    for (const [glob, path, want] of cases) expect([glob, path, matchGlob(glob, path)]).toEqual([glob, path, want]);
  });

  it('stays fast on patterns that make backtracking regexes explode', () => {
    const started = Date.now();
    expect(matchGlob('*a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(5_000))).toBe(false);
    expect(matchGlob('**a**a**a**a**a**b', 'a/'.repeat(500))).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('matching a finding to a decision', () => {
  const f = finding();

  it('prefers one occurrence over paths over the whole repo', () => {
    const repo = decision({ id: 'D-0001', action: 'disable' });
    const paths = decision({ id: 'D-0002', action: 'accept', match: { rule: 'semgrep:i18n', paths: ['src/app/**'] } });
    const one = decision({ id: 'D-0003', action: 'fix', match: { rule: 'semgrep:i18n', fingerprint: f.fingerprint, paths: [f.file] } });
    expect(matchDecision(f, [repo, paths, one], TODAY)?.id).toBe('D-0003');
    expect(matchDecision(f, [repo, paths], TODAY)?.id).toBe('D-0002');
    expect(matchDecision(f, [repo], TODAY)?.id).toBe('D-0001');
  });

  it('ignores decisions for other rules, other paths, other code, and expired ones', () => {
    expect(matchDecision(f, [decision({ action: 'accept', match: { rule: 'semgrep:other' } })], TODAY)).toBeUndefined();
    expect(matchDecision(f, [decision({ action: 'accept', match: { rule: 'semgrep:i18n', paths: ['src/db/**'] } })], TODAY)).toBeUndefined();
    expect(matchDecision(f, [decision({ action: 'accept', match: { rule: 'semgrep:i18n', fingerprint: 'a'.repeat(64) } })], TODAY)).toBeUndefined();
    expect(matchDecision(f, [decision({ action: 'accept', expires_on: '2026-10-12' })], TODAY)).toBeUndefined();
    expect(matchDecision(f, [decision({ action: 'accept', expires_on: TODAY })], TODAY)).toBeDefined();
  });
});

describe('applying decisions', () => {
  it('turns an accepted blocking finding into information, keeps a fix blocking, and hides a disabled rule', () => {
    const blocking = finding();
    expect(blocking.blocking).toBe(true);
    expect(applyDecisions([blocking], [decision({ action: 'accept' })], TODAY).findings[0]).toMatchObject({ blocking: false, decision: { id: 'D-0001', action: 'accept' } });
    expect(applyDecisions([blocking], [decision({ action: 'false-positive' })], TODAY).findings[0]?.blocking).toBe(false);
    expect(applyDecisions([blocking], [decision({ action: 'fix' })], TODAY).findings[0]?.blocking).toBe(true);
    const disabled = applyDecisions([blocking], [decision({ action: 'disable' })], TODAY);
    expect(disabled).toMatchObject({ findings: [], suppressed: 1 });
    expect([...disabled.used]).toEqual(['D-0001']);
  });

  it('says when a decision has expired', () => {
    expect(applyDecisions([], [decision({ action: 'accept', expires_on: '2026-01-01' })], TODAY).notes[0]).toMatch(/D-0001 expired/);
  });
});

describe('the decisions file', () => {
  it('creates the file, numbers decisions, and reads back what it wrote', () => {
    const { text, ids } = appendDecisions(undefined, [
      { action: 'disable', rule: 'semgrep:i18n', reason: 'Swedish only, no i18n planned' },
      { action: 'accept', rule: 'ts:eslint/no-restricted-syntax', paths: ['scripts/**'], reason: 'Scripts run in UTC', ref: 'docs/adr/0005.md', decided_by: 'Per' },
    ], TODAY);
    expect(ids).toEqual(['D-0001', 'D-0002']);
    expect(text).toMatch(/^# multi-code-review decisions/);
    const { decisions, notes } = parseDecisions(text);
    expect(notes).toEqual([]);
    expect(decisions).toEqual([
      { id: 'D-0001', action: 'disable', match: { rule: 'semgrep:i18n' }, reason: 'Swedish only, no i18n planned', decided_on: TODAY },
      { id: 'D-0002', action: 'accept', match: { rule: 'ts:eslint/no-restricted-syntax', paths: ['scripts/**'] }, reason: 'Scripts run in UTC', ref: 'docs/adr/0005.md', decided_by: 'Per', decided_on: TODAY },
    ]);
  });

  it('appends after the highest id and keeps hand-written comments', () => {
    const first = appendDecisions(undefined, [{ action: 'fix', rule: 'a:b', reason: 'later' }], TODAY).text;
    const edited = first.replace('decisions:', '# keep this note\ndecisions:');
    const second = appendDecisions(edited, [{ action: 'fix', rule: 'a:c', reason: 'later too' }], TODAY);
    expect(second.ids).toEqual(['D-0002']);
    expect(second.text).toContain('# keep this note');
    expect(parseDecisions(second.text).decisions.map((d) => d.id)).toEqual(['D-0001', 'D-0002']);
  });

  it('skips an invalid entry with a note instead of failing the review', () => {
    const { decisions, notes } = parseDecisions('decisions:\n  - id: D-0001\n    action: maybe\n');
    expect(decisions).toEqual([]);
    expect(notes[0]).toMatch(/entry 1 ignored/);
  });
});

describe('triage', () => {
  it('groups undecided findings by rule, blocking and most frequent first, and suggests a wider decision', () => {
    const many = ['a', 'b', 'c'].map((n, i) => finding({ file: `src/${n}.tsx`, severity: 'low', line: i + 1, endLine: i + 1 }, n));
    const block = finding({ ruleId: 'eval', category: 'security' });
    const decided = { ...finding({ ruleId: 'done' }), decision: { id: 'D-0009', action: 'accept' as const, reason: 'ok' } };
    const groups = triageGroups([...many, block, decided], []);
    expect(groups.map((g) => g.rule)).toEqual(['semgrep:eval', 'semgrep:i18n']);
    expect(groups[1]).toMatchObject({ count: 3, files: ['src/a.tsx', 'src/b.tsx', 'src/c.tsx'] });
    expect(groups[1]?.suggestion).toMatch(/3 files/);
  });
});

describe('fix report', () => {
  function review(over: Partial<Review>): Review {
    return {
      id: 'R-00000000', scope: 'diff', repoRoot: '/r', base: 'origin/develop', mergeBase: 'abc', head: 'def', changedFiles: 1,
      analyzedFiles: ['src/app/page.tsx'], analyzers: [{ name: 'semgrep', files: 1, findings: 0, durationMs: 1 }],
      findings: [], preexisting: 0, blocking: 0, suppressed: 0, decisions: [], decisionsUsed: [], tier: 'lite', levels: { security: 'medium', architecture: 'medium', 'best-practices': 'medium', testing: 'medium', correctness: 'medium', reliability: 'medium' }, belowLevel: 0, judged: 0, notes: [], ...over,
    };
  }

  it('lists decided fixes and undecided blockers, and marks a fix whose finding is gone as resolved', () => {
    const f = finding();
    const fix = decision({ id: 'D-0001', action: 'fix', match: { rule: 'semgrep:i18n', fingerprint: f.fingerprint, paths: [f.file] } });
    const stillThere = fixReport(review({ findings: [{ ...f, decision: { id: 'D-0001', action: 'fix', reason: 'x' } }], decisions: [fix], decisionsUsed: ['D-0001'] }));
    expect(stillThere.toFix).toHaveLength(1);
    expect(stillThere.resolved).toEqual([]);
    const gone = fixReport(review({ decisions: [fix] }));
    expect(gone.resolved.map((d) => d.id)).toEqual(['D-0001']);
    expect(fixReport(review({ findings: [f] })).toFix).toHaveLength(1);
  });

  it('does not call a repo-wide decision stale from a diff, nor one whose analyzer did not run', () => {
    const repoWide = decision({ action: 'disable' });
    expect(fixReport(review({ decisions: [repoWide] })).stale).toEqual([]);
    expect(fixReport(review({ scope: 'all', decisions: [repoWide] })).stale.map((d) => d.id)).toEqual(['D-0001']);
    expect(fixReport(review({ scope: 'all', decisions: [repoWide], analyzers: [{ name: 'ts', files: 1, findings: 0, durationMs: 1 }] })).stale).toEqual([]);
  });
});
