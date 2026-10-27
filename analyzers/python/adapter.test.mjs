import { describe, expect, it } from 'vitest';
import { banditConfigArgs, banditSeverity, hasRuffConfig, parseBandit, parseRuff, ruffArgs, ruffCategory, ruffSeverity } from './adapter.mjs';

const fsOf = (files) => [(f) => f in files, (f) => files[f]];

describe('python analyzer', () => {
  it('maps Ruff rule codes onto our categories by linter prefix', () => {
    expect(ruffCategory('S608')).toBe('security');
    expect(ruffCategory('SIM102')).toBe('best-practices');
    expect(ruffCategory('F821')).toBe('correctness');
    expect(ruffCategory('E999')).toBe('correctness');
    expect(ruffCategory('invalid-syntax')).toBe('correctness');
    expect(ruffCategory('B006')).toBe('correctness');
    expect(ruffCategory('BLE001')).toBe('reliability');
    expect(ruffCategory('TRY300')).toBe('reliability');
    expect(ruffCategory('ASYNC230')).toBe('reliability');
    expect(ruffCategory('PT011')).toBe('testing');
    expect(ruffCategory('PLE0101')).toBe('correctness');
    expect(ruffCategory('PLR0913')).toBe('best-practices');
    expect(ruffCategory('E501')).toBe('best-practices');
    expect(ruffCategory('E722')).toBe('reliability');
  });

  it('rates Ruff findings', () => {
    expect(ruffSeverity('F821')).toBe('high');
    expect(ruffSeverity('S602')).toBe('high');
    expect(ruffSeverity('invalid-syntax')).toBe('high');
    expect(ruffSeverity('S101')).toBe('low');
    expect(ruffSeverity('S105')).toBe('medium');
    expect(ruffSeverity('E722')).toBe('medium');
    expect(ruffSeverity('B006')).toBe('medium');
    expect(ruffSeverity('F401')).toBe('low');
    expect(ruffSeverity('SIM108')).toBe('low');
  });

  it("uses the repo's Ruff config when present, else the default selection", () => {
    expect(hasRuffConfig(...fsOf({ 'ruff.toml': '' }))).toBe(true);
    expect(hasRuffConfig(...fsOf({ 'pyproject.toml': '[project]\n\n[tool.ruff.lint]\nselect=["E"]\n' }))).toBe(true);
    expect(hasRuffConfig(...fsOf({ 'pyproject.toml': '[project]\nname="x"\n' }))).toBe(false);
    expect(ruffArgs(true, ['a.py'])).not.toContain('--select');
    expect(ruffArgs(false, ['a.py'])).toEqual(['check', '--output-format', 'json', '--no-cache', '--force-exclude', '--select', 'E9,E722,F,B,S,ASYNC,BLE,PT,SIM,UP,PL,RUF,TRY', '--', 'a.py']);
  });

  it('parses Ruff JSON with paths relative to the root', () => {
    const json = [
      { code: 'B006', message: 'Do not use mutable data structures for argument defaults', filename: '/src/app/a.py', location: { row: 2, column: 9 }, end_location: { row: 2, column: 11 }, url: 'https://docs.astral.sh/ruff/rules/mutable-argument-default', name: 'mutable-argument-default' },
      { code: 'invalid-syntax', message: 'unexpected EOF', filename: '/src/app/b.py', location: { row: 1, column: 7 }, end_location: { row: 1, column: 8 }, url: null, name: null },
    ];
    expect(parseRuff(json, '/src/app')).toEqual([
      { ruleId: 'B006', message: 'Do not use mutable data structures for argument defaults', file: 'a.py', line: 2, endLine: 2, column: 9, category: 'correctness', severity: 'medium', helpUri: 'https://docs.astral.sh/ruff/rules/mutable-argument-default', ruleName: 'mutable-argument-default' },
      { ruleId: 'syntax-error', message: 'unexpected EOF', file: 'b.py', line: 1, endLine: 1, column: 7, category: 'correctness', severity: 'high', helpUri: undefined, ruleName: undefined },
    ]);
  });

  it('picks the Bandit config and downgrades low-confidence issues', () => {
    expect(banditConfigArgs(...fsOf({ 'pyproject.toml': '[tool.bandit]\nskips=["B101"]\n' }))).toEqual(['-c', 'pyproject.toml']);
    expect(banditConfigArgs(...fsOf({ '.bandit': '[bandit]\n' }))).toEqual(['--ini', '.bandit']);
    expect(banditConfigArgs(...fsOf({ 'pyproject.toml': '[project]\n' }))).toEqual([]);
    expect(banditSeverity('HIGH', 'HIGH')).toBe('high');
    expect(banditSeverity('HIGH', 'LOW')).toBe('medium');
    expect(banditSeverity('MEDIUM', 'MEDIUM')).toBe('medium');
    expect(banditSeverity('LOW', 'LOW')).toBe('low');
  });

  it('parses the Bandit report', () => {
    const json = {
      results: [{ filename: './pkg/a.py', line_number: 3, line_range: [3, 4], col_offset: 7, issue_severity: 'HIGH', issue_confidence: 'HIGH', issue_text: 'Starting a process with a shell.', issue_cwe: { id: 78 }, test_id: 'B605', test_name: 'start_process_with_a_shell', more_info: 'https://bandit' }],
    };
    expect(parseBandit(json, '/src/app')).toEqual([
      { ruleId: 'B605', message: 'Starting a process with a shell. (CWE-78)', file: 'pkg/a.py', line: 3, endLine: 4, column: 8, category: 'security', severity: 'high', helpUri: 'https://bandit', ruleName: 'start_process_with_a_shell' },
    ]);
  });
});
