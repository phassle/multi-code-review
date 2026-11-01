import { describe, expect, it } from 'vitest';
import { takeTurns } from '../src/queue.ts';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('takeTurns', () => {
  it('runs one task per key at a time, different keys together, and survives failures', async () => {
    const turns = takeTurns();
    const running = new Map<string, number>();
    const peak = new Map<string, number>();
    let together = 0;
    let maxTogether = 0;
    const task = (key: string, fail = false) => async () => {
      running.set(key, (running.get(key) ?? 0) + 1);
      peak.set(key, Math.max(peak.get(key) ?? 0, running.get(key)!));
      maxTogether = Math.max(maxTogether, ++together);
      await tick();
      running.set(key, running.get(key)! - 1);
      together--;
      if (fail) throw new Error('boom');
      return key;
    };
    const results = await Promise.allSettled([
      turns('semgrep', task('semgrep', true)),
      turns('semgrep', task('semgrep')),
      turns('semgrep', task('semgrep')),
      turns('pmd', task('pmd')),
      turns(undefined, task('llm')),
      turns(undefined, task('llm')),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(peak.get('semgrep')).toBe(1);
    expect(peak.get('llm')).toBe(2);
    expect(maxTogether).toBeGreaterThanOrEqual(3);
  });
});
