import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The image build runs `semgrep --test` on these; this checks the layout it relies on.
const ROOT = fileURLToPath(new URL('./rules', import.meta.url));
const CATEGORIES = ['security', 'architecture', 'best-practices', 'testing', 'correctness', 'reliability'];

function ruleFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? ruleFiles(join(dir, e.name)) : e.name.endsWith('.yaml') ? [join(dir, e.name)] : [],
  );
}

describe('our semgrep rules', () => {
  const files = ruleFiles(ROOT);

  it('sit under a known category, with metadata.category matching their folder', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const folder = f.slice(ROOT.length + 1).split('/')[0];
      expect(CATEGORIES).toContain(folder);
      expect(readFileSync(f, 'utf8')).toMatch(new RegExp(`category: ${folder}\\b`));
    }
  });

  it('each have a test target with a ruleid annotation', () => {
    for (const f of files) {
      const stem = f.slice(0, -'.yaml'.length);
      const dir = stem.slice(0, stem.lastIndexOf('/'));
      const name = stem.slice(stem.lastIndexOf('/') + 1);
      const targets = readdirSync(dir).filter((t) => t.startsWith(`${name}.`) && !t.endsWith('.yaml')).map((t) => join(dir, t));
      expect(targets.length, f).toBeGreaterThan(0);
      expect(targets.some((t) => existsSync(t) && readFileSync(t, 'utf8').includes(`ruleid: ${name}`)), f).toBe(true);
    }
  });
});
