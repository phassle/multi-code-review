import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CATALOG } from '../src/catalog.ts';

// compose.yaml and the catalog must describe the same containers.
describe('compose.yaml', () => {
  const compose = parse(readFileSync(new URL('../../compose.yaml', import.meta.url), 'utf8'), { maxAliasCount: -1, merge: true }) as {
    services: Record<string, { profiles?: string[]; environment?: Record<string, string> }>;
  };
  const analyzers = Object.entries(compose.services).filter(([name]) => name !== 'review-mcp' && name !== 'report-store');

  it('has one service per catalog entry, in the same profile and category', () => {
    expect(analyzers.map(([name]) => name).sort()).toEqual(CATALOG.map((e) => e.name).sort());
    for (const [name, svc] of analyzers) {
      const entry = CATALOG.find((e) => e.name === name)!;
      expect(svc.profiles?.[0] ?? 'core', name).toBe(entry.profile);
      expect(svc.environment?.MCR_CATEGORY, name).toBe(entry.category);
    }
  });
});
