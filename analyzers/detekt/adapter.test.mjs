import { describe, expect, it } from 'vitest';
import { detektCategory, detektSeverity, parseDetekt, splitRuleId } from './adapter.mjs';

describe('detekt analyzer', () => {
  it('maps detekt rule sets onto ours', () => {
    expect(splitRuleId('detekt.potential-bugs.UnsafeCast')).toEqual({ ruleset: 'potential-bugs', rule: 'UnsafeCast' });
    expect(detektCategory('potential-bugs')).toBe('correctness');
    expect(detektCategory('coroutines')).toBe('reliability');
    expect(detektCategory('exceptions')).toBe('reliability');
    expect(detektCategory('performance')).toBe('reliability');
    expect(detektCategory('style')).toBe('best-practices');
    expect(detektCategory('libraries')).toBe('best-practices');
    expect(detektSeverity('error', 'style')).toBe('high');
    expect(detektSeverity('warning', 'potential-bugs')).toBe('medium');
    expect(detektSeverity('warning', 'style')).toBe('low');
    expect(detektSeverity('note', 'coroutines')).toBe('low');
  });

  it('parses the SARIF report with paths relative to the root', () => {
    const sarif = {
      runs: [
        {
          originalUriBaseIds: { '%SRCROOT%': { uri: 'file:///src/acme/' } },
          tool: { driver: { rules: [{ id: 'detekt.coroutines.GlobalCoroutineUsage', helpUri: 'https://detekt.dev/coroutines.html' }] } },
          results: [
            {
              ruleId: 'detekt.coroutines.GlobalCoroutineUsage',
              level: 'warning',
              message: { text: 'Usage of GlobalScope instance is highly discouraged ' },
              locations: [{ physicalLocation: { artifactLocation: { uri: 'src/Main.kt', uriBaseId: '%SRCROOT%' }, region: { startLine: 15, endLine: 17, startColumn: 9 } } }],
            },
            {
              ruleId: 'detekt.style.MagicNumber',
              level: 'warning',
              message: { text: 'This expression contains a magic number.' },
              locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///src/acme/B.kts' }, region: { startLine: 2 } } }],
            },
          ],
        },
      ],
    };
    expect(parseDetekt(sarif, '/src/acme')).toEqual([
      { ruleId: 'GlobalCoroutineUsage', message: 'Usage of GlobalScope instance is highly discouraged', file: 'src/Main.kt', line: 15, endLine: 17, column: 9, category: 'reliability', severity: 'medium', helpUri: 'https://detekt.dev/coroutines.html' },
      { ruleId: 'MagicNumber', message: 'This expression contains a magic number.', file: 'B.kts', line: 2, endLine: undefined, column: undefined, category: 'best-practices', severity: 'low', helpUri: undefined },
    ]);
  });
});
