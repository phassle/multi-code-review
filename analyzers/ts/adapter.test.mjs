import { describe, expect, it } from 'vitest';
import { eslintCategory, parseTsc } from './adapter.mjs';

describe('ts analyzer', () => {
  it('maps a repo boundary rule to architecture and promise misuse to reliability', () => {
    expect(eslintCategory('no-restricted-syntax')).toBe('architecture');
    expect(eslintCategory('@typescript-eslint/no-floating-promises')).toBe('reliability');
    expect(eslintCategory('react-hooks/rules-of-hooks')).toBe('correctness');
    expect(eslintCategory('no-eval')).toBe('security');
    expect(eslintCategory('vitest/expect-expect')).toBe('testing');
    expect(eslintCategory('prefer-const')).toBe('best-practices');
    expect(eslintCategory(null)).toBe('correctness');
  });

  it('parses tsc diagnostics, including paths with parentheses', () => {
    const out = [
      "src/app/(tenant)/page.tsx(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      'noise line',
    ].join('\n');
    expect(parseTsc(out)).toEqual([
      expect.objectContaining({ ruleId: 'TS2322', file: 'src/app/(tenant)/page.tsx', line: 12, column: 5, severity: 'high', category: 'correctness' }),
    ]);
  });
});
