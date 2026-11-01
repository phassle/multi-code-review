import { describe, expect, it } from 'vitest';
import { MAX_INTENT_CHARS, fromCommits, intentOf } from '../src/intent.ts';

describe('intent', () => {
  it('prefers the caller, trimmed and capped', () => {
    expect(intentOf('  Add rate limiting to /login  ', ['feat: other'])).toEqual({ text: 'Add rate limiting to /login', source: 'caller' });
    const long = intentOf('x'.repeat(MAX_INTENT_CHARS + 50), []);
    expect(long?.text.length).toBe(MAX_INTENT_CHARS);
    expect(long?.text.endsWith('…')).toBe(true);
  });

  it('falls back to commit messages, oldest first, without trailers, merges, fixups or repeats', () => {
    const log = [
      'Fix review: handle empty cart\n\nCo-Authored-By: Bot <b@x>',
      'fixup! Add cart total',
      "Merge branch 'main' into cart",
      'Add cart total\n\nSums line items in cents, VAT included.\nSigned-off-by: Dev <d@x>',
      'Add cart total',
    ];
    expect(fromCommits(log)).toBe('- Add cart total\n  Sums line items in cents, VAT included.\n- Fix review: handle empty cart');
    expect(intentOf(undefined, log)?.source).toBe('commits');
    expect(intentOf('   ', log)?.source).toBe('commits');
  });

  it('is undefined with neither', () => {
    expect(intentOf(undefined, [])).toBeUndefined();
    expect(intentOf('', ["Merge pull request #4 from x/y"])).toBeUndefined();
  });
});
