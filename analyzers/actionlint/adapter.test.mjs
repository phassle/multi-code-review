import { describe, expect, it } from 'vitest';
import { classify, coveredByZizmor, isWorkflow, parseOutput, toFindings } from './adapter.mjs';

const WF = '.github/workflows/ci.yml';

/** One actionlint `{{json .}}` error. */
const err = (kind, message, line = 5, column = 9, filepath = WF) => ({ message, filepath, line, column, kind, snippet: '', end_column: column + 3 });

describe('actionlint analyzer', () => {
  it('only lints workflows under .github/workflows', () => {
    expect(
      ['.github/workflows/ci.yml', '.github/workflows/release.yaml', 'sub/.github/workflows/x.yml', 'action.yml', 'actions/setup/action.yaml', '.github/dependabot.yml', '.github/workflows/sub/x.yml', 'ci.yml'].map(isWorkflow),
    ).toEqual([true, true, true, false, false, false, false, false]);
  });

  it('maps rules to severity: broken workflows block, runner labels and deprecations do not', () => {
    const sev = (kind) => classify(err(kind, 'x')).severity;
    for (const k of ['syntax-check', 'expression', 'action', 'events', 'glob', 'job-needs', 'matrix', 'workflow-call', 'permissions', 'env-var', 'id', 'shell-name', 'if-cond']) expect(sev(k)).toBe('high');
    expect(sev('runner-label')).toBe('medium');
    expect(sev('deprecated-commands')).toBe('medium');
    expect(sev('something-new')).toBe('medium');
  });

  it('keys shellcheck findings on the SC code, medium, low only for style', () => {
    const sc = (level, code) => classify(err('shellcheck', `shellcheck reported issue in this script: SC${code}:${level}:1:6: Double quote to prevent globbing and word splitting`));
    expect(sc('info', 2086)).toEqual({ ruleId: 'shellcheck-SC2086', severity: 'medium', helpUri: 'https://www.shellcheck.net/wiki/SC2086' });
    expect(sc('warning', 2034).severity).toBe('medium');
    expect(sc('error', 1009).severity).toBe('medium');
    expect(sc('style', 2006)).toMatchObject({ ruleId: 'shellcheck-SC2006', severity: 'low' });
  });

  it('links to the actionlint check docs', () => {
    expect(classify(err('job-needs', 'x')).helpUri).toBe('https://github.com/rhysd/actionlint/blob/main/docs/checks.md#check-job-deps');
    expect(classify(err('unknown-kind', 'x')).helpUri).toBe('https://github.com/rhysd/actionlint/blob/main/docs/checks.md');
  });

  it('drops what zizmor reports: untrusted input in scripts, hardcoded credentials', () => {
    const untrusted = err('expression', '"github.event.issue.title" is potentially untrusted. avoid using it directly in inline scripts.');
    const creds = err('credentials', '"password" section in "container" section should be specified via secrets. do not put password value directly');
    const typo = err('expression', 'property "nope" is not defined in object type {os: string}');
    expect([untrusted, creds, typo].map(coveredByZizmor)).toEqual([true, true, false]);
    expect(toFindings([untrusted, creds, typo], [WF]).map((f) => f.ruleId)).toEqual(['expression']);
  });

  it('maps errors to findings, only for the given files', () => {
    const errors = [
      err('syntax-check', 'unexpected key "jobz" for "workflow" section', 3, 1),
      err('expression', 'property "nope" is not defined in object type {os: string}', 12, 24, `./${WF}`),
      err('shellcheck', 'shellcheck reported issue in this script: SC2086:info:1:6: Double quote to prevent globbing and word splitting', 14, 9),
      err('job-needs', 'job "a" needs job "b" which does not exist', 20, 5, '.github/workflows/other.yml'),
      err('syntax-check', 'could not parse', 0, 0),
    ];
    const findings = toFindings(errors, [WF]);
    expect(findings.map((f) => [f.ruleId, f.file, f.line, f.column, f.severity, f.category])).toEqual([
      ['syntax-check', WF, 3, 1, 'high', 'correctness'],
      ['expression', WF, 12, 24, 'high', 'correctness'],
      ['shellcheck-SC2086', WF, 14, 9, 'medium', 'correctness'],
      ['syntax-check', WF, 1, undefined, 'high', 'correctness'],
    ]);
    expect(findings[0]).toMatchObject({ message: 'unexpected key "jobz" for "workflow" section [syntax-check]', ruleName: 'syntax-check' });
  });

  it('parses actionlint output: an array, null or nothing', () => {
    expect(parseOutput('')).toEqual([]);
    expect(parseOutput('null\n')).toEqual([]);
    expect(parseOutput(JSON.stringify([err('id', 'x')]) + '\n')).toHaveLength(1);
    expect(() => parseOutput('not json')).toThrow();
  });
});
