import { describe, expect, it } from 'vitest';
import { relPath, toFindings } from './adapter.mjs';

describe('gitleaks analyzer', () => {
  it('reports a secret as high, on the repo-relative file, without the secret', () => {
    const [f] = toFindings([{ RuleID: 'github-pat', Description: 'GitHub token', File: '/repo/app/config.js', StartLine: 2, EndLine: 2, StartColumn: 15, Secret: 'REDACTED' }], '/tmp/gl-1', '/repo');
    expect(f).toMatchObject({ ruleId: 'github-pat', file: 'app/config.js', line: 2, category: 'security', severity: 'high' });
    expect(f.endLine).toBeUndefined();
    expect(f.message).not.toContain('REDACTED');
  });

  it('maps scratch links and repo paths back to the relative file', () => {
    expect(relPath('/tmp/gl-1/a/b.js', '/tmp/gl-1', '/repo')).toBe('a/b.js');
    expect(relPath('/repo/a/b.js', '/tmp/gl-1', '/repo')).toBe('a/b.js');
  });
});
