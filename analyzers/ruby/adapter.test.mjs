import { describe, expect, it } from 'vitest';
import { parseBrakeman, parseRubocop, rubocopCategory, rubocopHelpUri, rubocopSeverity, rubocopTargets } from './adapter.mjs';

describe('ruby analyzer', () => {
  it('maps cop departments onto our categories', () => {
    expect(rubocopCategory('Security/Eval')).toBe('security');
    expect(rubocopCategory('Lint/UselessAssignment')).toBe('correctness');
    expect(rubocopCategory('Rails/OutputSafety')).toBe('security');
    expect(rubocopCategory('Rails/SkipsModelValidations')).toBe('correctness');
    expect(rubocopCategory('Rails/Blank')).toBe('best-practices');
    expect(rubocopCategory('RSpec/ExampleLength')).toBe('testing');
    expect(rubocopCategory('Minitest/AssertNil')).toBe('testing');
    expect(rubocopCategory('Performance/Detect')).toBe('reliability');
    expect(rubocopCategory('Style/StringLiterals')).toBe('best-practices');
    expect(rubocopCategory('Metrics/MethodLength')).toBe('best-practices');
    expect(rubocopSeverity('fatal')).toBe('high');
    expect(rubocopSeverity('error')).toBe('high');
    expect(rubocopSeverity('warning')).toBe('medium');
    expect(rubocopSeverity('convention')).toBe('low');
    expect(rubocopSeverity('refactor')).toBe('low');
  });

  it('links cops to their docs and picks lintable files', () => {
    expect(rubocopHelpUri('Lint/UselessAssignment')).toBe('https://docs.rubocop.org/rubocop/cops_lint.html#lintuselessassignment');
    expect(rubocopHelpUri('Rails/OutputSafety')).toBe('https://docs.rubocop.org/rubocop-rails/cops_rails.html#railsoutputsafety');
    expect(rubocopHelpUri('Custom/Thing')).toBeUndefined();
    expect(rubocopTargets(['a.rb', 'lib/tasks/x.rake', 'app/views/a.html.erb', 'Gemfile', 'x.gemspec', 'README.md'])).toEqual(['a.rb', 'lib/tasks/x.rake', 'Gemfile', 'x.gemspec']);
  });

  it('parses the RuboCop JSON report with paths relative to the root', () => {
    const json = {
      files: [{ path: 'app/a.rb', offenses: [{ severity: 'warning', message: 'Lint/UselessAssignment: Useless assignment to variable - `x`.', cop_name: 'Lint/UselessAssignment', location: { start_line: 3, start_column: 5, last_line: 3 } }] }],
    };
    expect(parseRubocop(json, '/src/acme')).toEqual([
      { ruleId: 'Lint/UselessAssignment', message: 'Useless assignment to variable - `x`.', file: 'app/a.rb', line: 3, endLine: 3, column: 5, category: 'correctness', severity: 'medium', helpUri: 'https://docs.rubocop.org/rubocop/cops_lint.html#lintuselessassignment' },
    ]);
  });

  it('keeps only Brakeman warnings in the requested files, as security', () => {
    const warning = (file, confidence) => ({ warning_type: 'SQL Injection', check_name: 'SQL', message: 'Possible SQL injection', file, line: 4, link: 'https://brakeman', code: 'User.where(x)', confidence });
    const json = { warnings: [warning('app/a.rb', 'High'), warning('app/b.rb', 'High'), warning('app/a.rb', 'Weak')] };
    expect(parseBrakeman(json, ['app/a.rb'])).toEqual([
      { ruleId: 'SQL', ruleName: 'SQL Injection', message: 'SQL Injection: Possible SQL injection (User.where(x))', file: 'app/a.rb', line: 4, category: 'security', severity: 'high', helpUri: 'https://brakeman' },
      expect.objectContaining({ severity: 'low' }),
    ]);
  });
});
