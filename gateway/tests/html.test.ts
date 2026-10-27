import { describe, expect, it } from 'vitest';
import { classify } from '../src/findings.ts';
import { esc, html, mergeReports, metaOf, reportId, reportIndexHtml, reportResponse, reviewHtml } from '../src/html.ts';
import type { Review } from '../src/review.ts';

function review(over: Partial<Review>): Review {
  return {
    id: 'R-00000000', scope: 'diff', repoRoot: '/r', base: 'origin/develop', mergeBase: 'abc', head: 'def', changedFiles: 1,
    analyzedFiles: [], analyzers: [], findings: [], preexisting: 0, blocking: 0, suppressed: 0, decisions: [], decisionsUsed: [], tier: 'lite', levels: { security: 'medium', architecture: 'medium', 'best-practices': 'medium', testing: 'medium', correctness: 'medium', reliability: 'medium' }, belowLevel: 0, judged: 0, notes: [], ...over,
  };
}

const finding = (over: { ruleId?: string; message?: string; line?: number; pReal?: number; verdict?: 'real' | 'likely-false-positive'; helpUri?: string }) => ({
  ...classify({ analyzer: 'security-semgrep', ruleId: over.ruleId ?? 'r', message: over.message ?? 'm', file: 'a.ts', line: over.line ?? 1, endLine: over.line ?? 1, category: 'security', severity: 'high', helpUri: over.helpUri }, 'all', 'x'),
  ...(over.pReal !== undefined ? { assessment: { model: 'jev', pReal: over.pReal, verdict: over.verdict ?? 'real' } } : {}),
});

describe('HTML report', () => {
  it('escapes everything that comes from code or analyzers', () => {
    expect(esc(`<script>"&'`)).toBe('&lt;script&gt;&quot;&amp;&#39;');
    const html = reviewHtml(review({ findings: [finding({ message: '<img src=x onerror=alert(1)>' })], notes: ['<b>note</b>'] }), () => '>>    1| <script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>note</b>');
  });

  it('escapes values in html templates unless they are html themselves', () => {
    const inner = html`<b>${'<i>'}</b>`;
    expect(html`<p>${'<x>'}${inner}${[1, html`<br>`]}${undefined}${false}</p>`.value).toBe('<p>&lt;x&gt;<b>&lt;i&gt;</b>1<br></p>');
  });

  it('links only http(s) documentation', () => {
    expect(reviewHtml(review({ findings: [finding({ helpUri: 'javascript:alert(1)' })] }))).not.toContain('href="javascript:');
    expect(reviewHtml(review({ findings: [finding({ helpUri: 'https://x/rule' })] }))).toContain('href="https://x/rule"');
  });

  it('shows the verdict, the Jev fix list and one group per rule with its code', () => {
    const html = reviewHtml(
      review({ blocking: 2, findings: [{ ...finding({ line: 1, pReal: 0.05, verdict: 'likely-false-positive' }), blocking: true }, { ...finding({ line: 2, pReal: 0.1, verdict: 'likely-false-positive' }), blocking: true }, finding({ ruleId: 'other', pReal: 0.9 })] }),
      (f) => `>>    ${f.line}| code`,
    );
    expect(html).toContain('2 blocking');
    expect(html).toContain('To fix, per Jev <span class="count">1</span>');
    expect(html).toContain('0.05–0.10');
    expect(html).toContain('a human decides');
    expect(html.match(/<details class="finding/g)).toHaveLength(2);
    expect(html).toContain('<span class="hit">&gt;&gt;    2| code</span>');
  });

  it('lists recent reviews and says when one is missing', () => {
    const html = reportIndexHtml([metaOf(review({ id: 'R-11111111', blocking: 1 }))], 'R-22222222');
    expect(html).toContain('href="/reports/R-11111111"');
    expect(html).toContain('R-22222222 not found');
    expect(reportIndexHtml([])).toContain('No reviews yet');
  });

  it('serves reports only to allowed hosts, newest first, and 404s unknown ids', () => {
    const hosts = ['127.0.0.1:7700'];
    const reviews = new Map([['R-11111111', review({ id: 'R-11111111' })], ['R-22222222', review({ id: 'R-22222222' })]]);
    const get = (url: string, host?: string) => reportResponse(url, host, hosts, reviews, () => () => '');
    expect(get('/reports', 'evil.example:7700')).toEqual({ status: 403 });
    expect(get('/reports/R-11111111')).toEqual({ status: 403 });
    const index = get('/reports', '127.0.0.1:7700');
    expect(index.status).toBe(200);
    expect(index.body?.indexOf('R-22222222')).toBeLessThan(index.body?.indexOf('R-11111111') ?? 0);
    expect(get('/reports/R-11111111', '127.0.0.1:7700')).toMatchObject({ status: 200, body: expect.stringContaining('Review <code>R-11111111</code>') });
    expect(get('/reports/R-99999999', '127.0.0.1:7700')).toMatchObject({ status: 404, body: expect.stringContaining('R-99999999 not found') });
  });

  it('serves a stored page for a review no longer in memory, and lists stored reports after the ones in memory', () => {
    const hosts = ['127.0.0.1:7700'];
    const reviews = new Map([['R-11111111', review({ id: 'R-11111111' })]]);
    const old = { ...metaOf(review({ id: 'R-33333333', blocking: 2 })), storedAt: 1 };
    const stored = { reports: [old, { ...metaOf(review({ id: 'R-11111111' })), storedAt: 2 }], page: '<!doctype html><p>stored</p>', ttlDays: 7 };
    expect(reportResponse('/reports/R-33333333', '127.0.0.1:7700', hosts, reviews, () => () => '', stored)).toEqual({ status: 200, body: '<!doctype html><p>stored</p>' });
    // Not served to a host that is not allowed, stored or not.
    expect(reportResponse('/reports/R-33333333', 'evil.example', hosts, reviews, () => () => '', stored)).toEqual({ status: 403 });
    const index = reportResponse('/reports', '127.0.0.1:7700', hosts, reviews, () => () => '', stored).body ?? '';
    expect(index.match(/href="\/reports\/R-11111111"/g)).toHaveLength(1);
    expect(index.indexOf('R-11111111')).toBeLessThan(index.indexOf('R-33333333'));
    expect(index).toContain('Kept 7 days, then deleted.');
    const gone = reportResponse('/reports/R-44444444', '127.0.0.1:7700', hosts, reviews, () => () => '', { reports: [], ttlDays: 7 });
    expect(gone).toMatchObject({ status: 404, body: expect.stringContaining('older than 7 days') });
  });

  it('merges memory and store newest first, each review once', () => {
    const a = review({ id: 'R-0000000a' });
    const b = review({ id: 'R-0000000b' });
    expect(mergeReports([a, b], [{ ...metaOf(a), storedAt: 1 }, { ...metaOf(review({ id: 'R-0000000c' })), storedAt: 0 }]).map((m) => m.id)).toEqual(['R-0000000b', 'R-0000000a', 'R-0000000c']);
  });

  it('takes only well-formed report ids from a URL', () => {
    expect(reportId('/reports/R-0123abcd')).toBe('R-0123abcd');
    expect(reportId('/reports/../etc')).toBeUndefined();
    expect(reportId('/reports')).toBeUndefined();
  });
});
