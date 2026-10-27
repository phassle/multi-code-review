import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, goCategory, goSeverity, groupPackages, missingDeps, moduleRoot, parseGolangci, ruleCode } from './adapter.mjs';

describe('golangci-lint analyzer', () => {
  it('maps linters onto our categories', () => {
    expect(goCategory('gosec', 'G202: SQL string concatenation')).toBe('security');
    expect(goCategory('staticcheck', 'SA4006: this value of x is never used')).toBe('correctness');
    expect(goCategory('staticcheck', 'ST1005: error strings should not be capitalized')).toBe('best-practices');
    expect(goCategory('staticcheck', 'S1039: unnecessary use of fmt.Sprintf')).toBe('best-practices');
    expect(goCategory('govet', 'printf: ...')).toBe('correctness');
    expect(goCategory('nilerr', 'error is not nil')).toBe('correctness');
    expect(goCategory('errcheck', 'Error return value')).toBe('reliability');
    expect(goCategory('bodyclose', 'response body must be closed')).toBe('reliability');
    expect(goCategory('unused', 'func f is unused')).toBe('best-practices');
    expect(goCategory('revive', 'exported: ...')).toBe('best-practices');
  });

  it('derives severity', () => {
    expect(goSeverity('gosec', 'security', 'high')).toBe('high');
    expect(goSeverity('gosec', 'security', '')).toBe('medium');
    expect(goSeverity('typecheck', 'correctness', '')).toBe('high');
    expect(goSeverity('govet', 'correctness', '')).toBe('medium');
    expect(goSeverity('errcheck', 'reliability', '')).toBe('low');
    expect(ruleCode('G107: Potential HTTP request')).toBe('G107');
    expect(ruleCode('ineffectual assignment to x')).toBeUndefined();
  });

  it('finds the nearest module and groups package directories', () => {
    const mods = new Set(['/r/go.mod', '/r/tools/go.mod']);
    const exists = (p) => mods.has(p);
    expect(moduleRoot('/r', '/r/pkg/a', exists)).toBe('/r');
    expect(moduleRoot('/r/x', '/r/x/y', () => false)).toBeUndefined();
    const { groups, orphans } = groupPackages('/r', ['main.go', 'pkg/a/a.go', 'pkg/a/b.go', 'tools/gen/g.go', 'README.md'], exists);
    expect([...groups]).toEqual([
      ['/r', ['.', './pkg/a']],
      ['/r/tools', ['./gen']],
    ]);
    expect(orphans).toEqual([]);
  });

  it('keeps only requested files, relative to the root', () => {
    const json = {
      Issues: [
        { FromLinter: 'gosec', Text: 'G202: SQL string concatenation', Severity: 'medium', Pos: { Filename: '/r/svc/db.go', Line: 20, Column: 9 } },
        { FromLinter: 'errcheck', Text: 'Error return value of `os.Remove` is not checked', Severity: '', Pos: { Filename: '/r/svc/other.go', Line: 5, Column: 2 } },
        { FromLinter: 'staticcheck', Text: 'SA4006: this value of x is never used', Pos: { Filename: 'db.go', Line: 3, Column: 1 }, LineRange: { From: 3, To: 4 } },
      ],
    };
    expect(parseGolangci(json, '/r', '/r/svc', ['./svc/db.go'])).toEqual([
      { ruleId: 'gosec/G202', message: 'G202: SQL string concatenation', file: 'svc/db.go', line: 20, column: 9, category: 'security', severity: 'medium', helpUri: 'https://golangci-lint.run/docs/linters/configuration/#gosec' },
      { ruleId: 'staticcheck/SA4006', message: 'SA4006: this value of x is never used', file: 'svc/db.go', line: 3, endLine: 4, column: 1, category: 'correctness', severity: 'medium', helpUri: 'https://golangci-lint.run/docs/linters/configuration/#staticcheck' },
    ]);
  });

  it('splits compiler errors into located typecheck findings', () => {
    const json = { Issues: [{ FromLinter: 'typecheck', Text: ': # example.com/s\n./main.go:4:2: declared and not used: x\n./main.go:5:7: invalid operation', Pos: { Filename: '/r/main.go', Line: 1 } }] };
    expect(parseGolangci(json, '/r', '/r', ['main.go'])).toEqual([
      { ruleId: 'typecheck', message: 'declared and not used: x', file: 'main.go', line: 4, column: 2, category: 'correctness', severity: 'high' },
      { ruleId: 'typecheck', message: 'invalid operation', file: 'main.go', line: 5, column: 7, category: 'correctness', severity: 'high' },
    ]);
  });

  it('recognises missing offline dependencies', () => {
    expect(missingDeps('could not import github.com/google/uuid (svc.go:6:2: module lookup disabled by GOPROXY=off)')).toBe(true);
    expect(missingDeps('declared and not used: x')).toBe(false);
    expect(DEFAULT_CONFIG).toContain('version: "2"');
    expect(DEFAULT_CONFIG).toContain('gosec');
  });
});
