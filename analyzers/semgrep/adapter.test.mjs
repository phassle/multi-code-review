import { describe, expect, it } from 'vitest';
import { severityOf } from './adapter.mjs';

describe('semgrep analyzer', () => {
  it('never lets a low-confidence rule block', () => {
    expect(severityOf('ERROR', { confidence: 'HIGH' })).toBe('high');
    expect(severityOf('ERROR', { confidence: 'LOW' })).toBe('medium');
    expect(severityOf('INFO')).toBe('low');
  });
});
