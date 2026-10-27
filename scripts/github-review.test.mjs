import { describe, expect, it } from 'vitest';
import { anchor, commentableLines, githubReview, HTML_LINK_MARKER, MARKER, priority, ruleOf, titleAndText } from './github-review.mjs';

const finding = (over = {}) => ({
  id: 'F-00000001', fingerprint: 'abc123', analyzer: 'semgrep', ruleId: 'js.eval', message: 'Eval with user input. Use a parser instead.',
  file: 'src/a.js', line: 10, endLine: 10, category: 'security', severity: 'high', isNew: true, blocking: true, ...over,
});
const compact = (findings) => ({
  id: 'R-00000001', base: 'origin/develop', head: 'deadbeefcafe1234', changedFiles: 2, blocking: findings.filter((f) => f.blocking).length,
  analyzers: [{ name: 'security-semgrep', findings: 1, ms: 5 }, { name: 'testing-eslint', findings: 0, ms: 5, error: 'boom' }],
  findings: findings.map((f) => ({ id: f.id, category: f.category, severity: f.severity, ...(f.blocking ? { blocking: true } : {}), ...(f.isNew ? {} : { preexisting: true }), ...(f.decision ? { decision: `${f.decision.action} ${f.decision.id}` } : {}) })),
});
const prFiles = [{ filename: 'src/a.js', patch: '@@ -8,2 +8,4 @@ x\n a\n+b\n+c\n d\n@@ -40 +42 @@\n-x\n+y' }, { filename: 'gone.js' }];

describe('github review', () => {
  it('ranks P1 blocking, P2 warn, P3 info', () => {
    expect(priority(finding())).toBe('P1');
    expect(priority(finding({ blocking: false, severity: 'high' }))).toBe('P2');
    expect(priority(finding({ blocking: false, severity: 'low' }))).toBe('P3');
  });

  it('keys rules on the tool, not the container', () => {
    expect(ruleOf(finding({ analyzer: 'security-semgrep' }))).toBe('semgrep:js.eval');
    expect(ruleOf(finding({ analyzer: 'llm' }))).toBe('llm:js.eval');
  });

  it('splits a message into a title and the rest', () => {
    expect(titleAndText('Eval with user input. Use a parser instead.')).toEqual({ title: 'Eval with user input', text: 'Use a parser instead.' });
    expect(titleAndText('No period here')).toEqual({ title: 'No period here', text: '' });
    expect(titleAndText('Line one\nline two')).toEqual({ title: 'Line one', text: 'line two' });
  });

  it('reads the new-side line ranges of a patch and anchors inside them', () => {
    const lines = commentableLines(prFiles);
    expect(lines.get('src/a.js')).toEqual([[8, 11], [42, 42]]);
    expect(lines.get('gone.js')).toEqual([]);
    expect(anchor(finding({ line: 10 }), lines)).toBe(10);
    expect(anchor(finding({ line: 6, endLine: 9 }), lines)).toBe(8);
    expect(anchor(finding({ line: 20, endLine: 20 }), lines)).toBeUndefined();
    expect(anchor(finding({ file: 'other.js' }), lines)).toBeUndefined();
    expect(anchor(finding({ line: 20 }), undefined)).toBe(20);
  });

  it('comments on diff lines, lists the rest in the body, skips accepted and already commented', () => {
    const fs = [
      finding(),
      finding({ id: 'F-00000002', fingerprint: 'off', line: 20, endLine: 20, blocking: false, severity: 'medium', category: 'reliability' }),
      finding({ id: 'F-00000003', fingerprint: 'acc', decision: { id: 'D-0001', action: 'accept', reason: 'ok' }, blocking: false }),
      finding({ id: 'F-00000004', fingerprint: 'seen', line: 42, endLine: 42, blocking: false, severity: 'low' }),
    ];
    const r = githubReview(compact(fs), fs, { commit: 'deadbeefcafe1234', prFiles, skip: new Set(['seen']), reportUrl: 'https://run' });
    expect(r).toMatchObject({ commit_id: 'deadbeefcafe1234', event: 'COMMENT' });
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]).toMatchObject({ path: 'src/a.js', line: 10, side: 'RIGHT' });
    expect(r.comments[0].body).toContain('<!-- mcr:abc123 -->');
    expect(r.comments[0].body).toContain('![P1]');
    expect(r.comments[0].body).toContain('**Eval with user input**');
    expect(r.body.startsWith(MARKER)).toBe(true);
    expect(r.body).toContain('⛔ **1 blocking**');
    expect(r.body).toContain('**Not on a diff line** (1)');
    expect(r.body).toContain('`src/a.js:20`');
    expect(r.body).toContain('1 finding(s) already commented');
    expect(r.body).toContain('| testing | ❌ testing-eslint failed | 0 |');
    expect(r.body).toContain('| reliability | ⚠️ warn | 1 |');
    expect(r.body).not.toContain('F-00000003');
    expect(r.comments.map((c) => c.body).join()).not.toContain('F-00000003');
  });

  it('links the full report under the verdict, and leaves room for the HTML link', () => {
    const later = githubReview(compact([]), [], { reportUrl: 'https://run' });
    expect(later.body).toContain(`📄 **[Full report](https://run)**: every finding with its code${HTML_LINK_MARKER}`);
    const both = githubReview(compact([]), [], { reportUrl: 'https://run', htmlUrl: 'https://html' });
    expect(both.body).toContain('📄 **[Full report](https://run)**: every finding with its code · [HTML](https://html)');
    expect(both.body).not.toContain(HTML_LINK_MARKER);
    expect(githubReview(compact([]), [], {}).body).not.toContain('Full report');
  });
});
