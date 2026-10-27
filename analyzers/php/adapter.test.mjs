import { describe, expect, it } from 'vitest';
import { parsePhpstan, phpstanCategory, phpstanSeverity, wrapperConfig } from './adapter.mjs';

describe('phpstan analyzer', () => {
  it('maps identifiers onto our categories and severities', () => {
    expect(phpstanCategory('variable.undefined')).toBe('correctness');
    expect(phpstanCategory('argument.type')).toBe('correctness');
    expect(phpstanCategory('deadCode.unreachable')).toBe('correctness');
    expect(phpstanCategory('missingType.iterableValue')).toBe('best-practices');
    expect(phpstanCategory('phpDoc.parseError')).toBe('best-practices');
    expect(phpstanCategory('unusedFunction')).toBe('best-practices');
    expect(phpstanCategory('something.else')).toBe('correctness');
    expect(phpstanCategory(undefined)).toBe('correctness');
    expect(phpstanSeverity('method.notFound')).toBe('high');
    expect(phpstanSeverity('class.notFound')).toBe('high');
    expect(phpstanSeverity('variable.undefined')).toBe('high');
    expect(phpstanSeverity('return.type')).toBe('medium');
    expect(phpstanSeverity('missingType.return')).toBe('low');
  });

  it('wraps the repo config, or defaults to level 5, keeping caches under /tmp', () => {
    const own = wrapperConfig({ root: '/src/app', repoConfig: 'phpstan.neon', hasAutoload: true });
    expect(own).toContain("  - '/src/app/phpstan.neon'");
    expect(own).toContain("tmpDir: '/tmp/phpstan'");
    expect(own).not.toContain('level:');
    expect(own).not.toContain('scanDirectories');
    const fallback = wrapperConfig({ root: "/src/o'app", hasAutoload: false });
    expect(fallback).not.toContain('includes');
    expect(fallback).toContain('level: 5');
    expect(fallback).toContain("    - '/src/o''app'");
  });

  it('parses the JSON report with paths relative to the root', () => {
    const json = {
      totals: { errors: 0, file_errors: 2 },
      files: {
        '/src/app/src/A.php': {
          errors: 2,
          messages: [
            { message: 'Undefined variable: $x', line: 7, ignorable: true, identifier: 'variable.undefined' },
            { message: 'Old-style error', line: 9, ignorable: true, tip: 'Try\n this' },
          ],
        },
      },
      errors: [],
    };
    expect(parsePhpstan(json, '/src/app')).toEqual([
      { ruleId: 'variable.undefined', message: 'Undefined variable: $x', file: 'src/A.php', line: 7, category: 'correctness', severity: 'high', helpUri: 'https://phpstan.org/error-identifiers/variable' },
      { ruleId: 'phpstan', message: 'Old-style error (Try this)', file: 'src/A.php', line: 9, category: 'correctness', severity: 'medium', helpUri: undefined },
    ]);
  });
});
