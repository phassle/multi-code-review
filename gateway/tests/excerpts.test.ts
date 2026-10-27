import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify } from '../src/findings.ts';
import { codeExcerpts } from '../src/review.ts';

describe('code excerpts for the fix list', () => {
  const root = mkdtempSync(join(tmpdir(), 'mcr-excerpt-'));
  writeFileSync(join(root, 'a.ts'), Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n'));
  const at = (file: string, line: number, endLine = line) =>
    classify({ analyzer: 'security-semgrep', ruleId: 'r', message: 'm', file, line, endLine, category: 'security', severity: 'high' }, 'all', 'x');

  it('shows ±radius lines and marks the flagged ones with >>', () => {
    const out = codeExcerpts(root, 2)(at('a.ts', 10, 11)).split('\n');
    expect(out).toHaveLength(6); // 8..13
    expect(out[0]).toBe('      8| line8');
    expect(out[2]).toBe('>>   10| line10');
    expect(out[3]).toBe('>>   11| line11');
    expect(out[4]).toBe('     12| line12');
  });

  it('clips the window at the start of the file', () => {
    expect(codeExcerpts(root, 2)(at('a.ts', 1)).split('\n')[0]).toBe('>>    1| line1');
  });

  it('gives nothing for a file it cannot read', () => {
    expect(codeExcerpts(root)(at('missing.ts', 3))).toBe('');
  });

  it('gives nothing, instead of failing, when the repository is gone', () => {
    expect(codeExcerpts(join(root, 'deleted-repo'))(at('a.ts', 3))).toBe('');
  });

  it('shows nothing from outside the repository, by path or by symlink', () => {
    const outside = mkdtempSync(join(tmpdir(), 'mcr-outside-'));
    writeFileSync(join(outside, 'secret'), 'sk-secret');
    symlinkSync(join(outside, 'secret'), join(root, 'link'));
    expect(codeExcerpts(root)(at('../' + outside.split('/').pop() + '/secret', 1))).toBe('');
    expect(codeExcerpts(root)(at('link', 1))).toBe('');
  });

  it('shows the start of a long flagged range, not all of it', () => {
    const out = codeExcerpts(root, 2)(at('a.ts', 2, 19)).split('\n');
    expect(out[0]).toBe('      1| line1');
    expect(out.filter((l) => l.startsWith('>>'))).toHaveLength(12);
    expect(out.at(-1)).toContain('6 more flagged lines, to 19');
  });
});
