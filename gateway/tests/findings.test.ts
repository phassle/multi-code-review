import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, touchesChange } from '../src/diff.ts';
import { classify, dedupe, fingerprint, fromSarif, uniqueIds, type RawFinding } from '../src/findings.ts';
import { filesFor, parseRegistry } from '../src/analyzers.ts';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -3 +3,2 @@ export const x = 1;
-old
+new
+newer
@@ -10,2 +11,0 @@
-gone
-gone too
diff --git a/src/gone.ts b/src/gone.ts
--- a/src/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

const raw: RawFinding = {
  analyzer: 'semgrep',
  ruleId: 'eval-detected',
  message: 'eval',
  file: 'src/a.ts',
  line: 4,
  endLine: 4,
  category: 'security',
  severity: 'high',
};

describe('changed lines', () => {
  it('records added ranges and ignores pure deletions and deleted files', () => {
    const changed = parseUnifiedDiff(DIFF);
    expect(changed.get('src/a.ts')).toEqual([[3, 4]]);
    expect(changed.has('src/gone.ts')).toBe(false);
  });

  it('counts a finding as new when any of its lines overlaps a change', () => {
    expect(touchesChange([[3, 4]], 4)).toBe(true);
    expect(touchesChange([[3, 4]], 1, 3)).toBe(true);
    expect(touchesChange([[3, 4]], 5, 9)).toBe(false);
    expect(touchesChange('all', 999)).toBe(true);
    expect(touchesChange(undefined, 1)).toBe(false);
  });
});

describe('classifying findings', () => {
  it('blocks a new high-severity finding', () => {
    expect(classify(raw, [[3, 4]], 'eval(x)')).toMatchObject({ isNew: true, blocking: true });
  });

  it('informs, never blocks, on a pre-existing finding', () => {
    expect(classify(raw, [[10, 12]], 'eval(x)')).toMatchObject({ isNew: false, blocking: false });
  });

  it('does not block a new medium-severity finding', () => {
    expect(classify({ ...raw, severity: 'medium' }, 'all', 'eval(x)').blocking).toBe(false);
  });

  it('keeps the fingerprint when the code moves or is re-indented', () => {
    expect(fingerprint(raw, '  eval(x)')).toBe(fingerprint({ ...raw }, 'eval(x)  '));
    expect(fingerprint(raw, 'eval(x)')).not.toBe(fingerprint(raw, 'eval(y)'));
    expect(classify(raw, 'all', 'eval(x)').id).toBe(classify({ ...raw, line: 40, endLine: 40 }, 'all', 'eval(x)').id);
  });

  it('gives identical lines in one review their own ids, the first keeping the stable one', () => {
    const first = classify({ ...raw, line: 9, endLine: 9 }, 'all', 'eval(x)');
    const second = classify({ ...raw, line: 30, endLine: 30 }, 'all', 'eval(x)');
    const [b, a] = uniqueIds([second, first]);
    expect(a?.id).toBe(first.id);
    expect(b?.id).not.toBe(first.id);
    expect(b?.id).toMatch(/^F-[0-9a-f]{8}$/);
    expect(b?.fingerprint).toBe(first.fingerprint);
  });

  it('collapses the same rule on the same line reported twice', () => {
    const f = classify(raw, 'all', 'eval(x)');
    expect(dedupe([f, { ...f }])).toHaveLength(1);
  });
});

describe('reading SARIF', () => {
  it('takes category and severity from properties, falling back to the SARIF level', () => {
    const { findings, notes } = fromSarif('third-party', {
      runs: [
        {
          tool: { driver: { rules: [{ id: 'r1', helpUri: 'https://example.test/r1' }] } },
          invocations: [{ toolExecutionNotifications: [{ message: { text: 'skipped big.ts' } }] }],
          results: [
            {
              ruleId: 'r1',
              level: 'warning',
              message: { text: 'm1' },
              locations: [{ physicalLocation: { artifactLocation: { uri: './src/a.ts' }, region: { startLine: 2 } } }],
              properties: { category: 'reliability', severity: 'high' },
            },
            {
              ruleId: 'r2',
              level: 'error',
              message: { text: 'm2' },
              locations: [{ physicalLocation: { artifactLocation: { uri: 'src/b.ts' }, region: { startLine: 5, endLine: 7 } } }],
            },
            { ruleId: 'no-location', message: { text: 'dropped' } },
          ],
        },
      ],
    });
    expect(findings).toEqual([
      expect.objectContaining({ ruleId: 'r1', file: 'src/a.ts', line: 2, endLine: 2, category: 'reliability', severity: 'high', helpUri: 'https://example.test/r1' }),
      expect.objectContaining({ ruleId: 'r2', file: 'src/b.ts', line: 5, endLine: 7, category: 'best-practices', severity: 'high' }),
    ]);
    expect(notes).toEqual(['third-party: skipped big.ts']);
  });
});

describe('analyzer registry', () => {
  it('parses name=url pairs', () => {
    expect(parseRegistry('semgrep=http://semgrep:8080/, ts=http://ts:8080')).toEqual([
      { name: 'semgrep', url: 'http://semgrep:8080' },
      { name: 'ts', url: 'http://ts:8080' },
    ]);
    expect(parseRegistry(undefined)).toEqual([]);
    expect(() => parseRegistry('broken')).toThrow();
  });

  it('routes files by extension or exact basename', () => {
    const info = { name: 'x', version: '1', languages: [], categories: [], extensions: ['.ts', 'Dockerfile'] };
    expect(filesFor(info, ['a.ts', 'b.py', 'docker/Dockerfile', 'Dockerfile.dev'])).toEqual(['a.ts', 'docker/Dockerfile']);
  });

  it('routes files by a basename prefix ending in "."', () => {
    const info = { name: 'hadolint', version: '1', languages: [], categories: [], extensions: ['Dockerfile', 'Dockerfile.', '.dockerfile'] };
    expect(filesFor(info, ['Dockerfile', 'api/Dockerfile.prod', 'web/app.dockerfile', 'Dockerfiles/readme.md', 'a.ts'])).toEqual(['Dockerfile', 'api/Dockerfile.prod', 'web/app.dockerfile']);
  });
});
