import { describe, expect, it } from 'vitest';
import { blocks, defaultLevels, parseSettings, runs, shown } from '../src/settings.ts';

describe('review levels', () => {
  const defaults = defaultLevels().levels;

  it('defaults every category to medium, and MCR_LEVELS overrides', () => {
    expect(defaults.security).toBe('medium');
    const d = defaultLevels('security=maximum, testing=minimum, bogus=max');
    expect(d.levels.security).toBe('maximum');
    expect(d.levels.testing).toBe('minimum');
    expect(d.notes).toEqual(['MCR_LEVELS: ignored "bogus=max"']);
  });

  it('reads .mcr/settings.yml over the defaults, and keeps them when the file is wrong', () => {
    const ok = parseSettings('review:\n  security: maximum\n  best-practices: off\n', defaults);
    expect(ok.levels.security).toBe('maximum');
    expect(ok.levels['best-practices']).toBe('off');
    expect(ok.levels.correctness).toBe('medium');
    expect(parseSettings('review:\n  security: extreme\n', defaults).levels.security).toBe('medium');
    expect(parseSettings('review:\n  speling: maximum\n', defaults).notes[0]).toContain('unknown category');
  });

  it('runs analyzers unless off; the LLM reviewer from medium, on trivial diffs only at maximum', () => {
    expect(runs('off', false, false)).toBe(false);
    expect(runs('minimum', false, false)).toBe(true);
    expect(runs('minimum', true, false)).toBe(false);
    expect(runs('medium', true, false)).toBe(true);
    expect(runs('medium', true, true)).toBe(false);
    expect(runs('maximum', true, true)).toBe(true);
  });

  it('blocks on high, and on medium too at maximum; shows less at lower levels', () => {
    expect(blocks('medium', 'medium')).toBe(false);
    expect(blocks('maximum', 'medium')).toBe(true);
    expect(blocks('maximum', 'low')).toBe(false);
    expect(shown('minimum', 'medium')).toBe(false);
    expect(shown('medium', 'low')).toBe(false);
    expect(shown('maximum', 'low')).toBe(true);
    expect(shown('off', 'high')).toBe(false);
  });
});
