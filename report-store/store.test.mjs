import { describe, expect, it } from 'vitest';
import { DAY_MS, expired, ttlMs, validate } from './store.mjs';

describe('report store', () => {
  it('keeps reports 7 days unless MCR_REPORT_TTL_DAYS says otherwise', () => {
    expect(ttlMs(undefined)).toBe(7 * DAY_MS);
    expect(ttlMs('')).toBe(7 * DAY_MS);
    expect(ttlMs('-1')).toBe(7 * DAY_MS);
    expect(ttlMs('1.5')).toBe(1.5 * DAY_MS);
  });

  it('expires a report at its TTL, and one without a stored time at once', () => {
    const ttl = ttlMs('7');
    expect(expired(0, 1, ttl)).toBe(true);
    expect(expired(undefined, 1, ttl)).toBe(true);
    expect(expired(1000, 1000 + ttl - 1, ttl)).toBe(false);
    expect(expired(1000, 1000 + ttl, ttl)).toBe(true);
  });

  it('stores only a page under a review id, with the metadata it needs', () => {
    const page = '<!doctype html><html></html>';
    expect(validate('../etc', { meta: {}, html: page }, 1).error).toBe('bad id');
    expect(validate('R-0000000g', { meta: {}, html: page }, 1).error).toBe('bad id');
    expect(validate('R-00000000', { meta: {}, html: '<script>' }, 1).error).toBe('html must be a page');
    expect(validate('R-00000000', { html: page }, 1).error).toBe('meta must be an object');
    const { doc } = validate('R-00000000', { meta: { repoRoot: '/r', scope: 'all', base: 'x', blocking: '2', findings: 3, extra: 'dropped' }, html: page }, 42);
    expect(doc.meta).toEqual({ id: 'R-00000000', repoRoot: '/r', scope: 'all', base: 'x', blocking: 2, findings: 3, storedAt: 42 });
  });
});
