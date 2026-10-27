import { describe, expect, it } from 'vitest';
import { parsePmd, pmdCategory, pmdSeverity } from './adapter.mjs';

describe('pmd analyzer', () => {
  it('maps PMD categories onto ours', () => {
    expect(pmdCategory('Security')).toBe('security');
    expect(pmdCategory('Error Prone')).toBe('correctness');
    expect(pmdCategory('Multithreading')).toBe('reliability');
    expect(pmdCategory('Design')).toBe('architecture');
    expect(pmdCategory('Code Style')).toBe('best-practices');
    expect(pmdSeverity(1)).toBe('high');
    expect(pmdSeverity(3)).toBe('medium');
    expect(pmdSeverity(5)).toBe('low');
  });

  it('parses the JSON report with paths relative to the root', () => {
    const json = {
      files: [{ filename: '/src/acme/A.java', violations: [{ beginline: 3, endline: 4, begincolumn: 5, description: 'Avoid empty catch blocks', rule: 'EmptyCatchBlock', ruleset: 'Error Prone', priority: 3, externalInfoUrl: 'https://pmd' }] }],
    };
    expect(parsePmd(json, '/src/acme')).toEqual([
      { ruleId: 'EmptyCatchBlock', message: 'Avoid empty catch blocks', file: 'A.java', line: 3, endLine: 4, column: 5, category: 'correctness', severity: 'medium', helpUri: 'https://pmd' },
    ]);
  });
});
