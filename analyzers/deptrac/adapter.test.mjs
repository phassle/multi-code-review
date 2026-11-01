import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyze, countsNote, groupByConfig, nearestConfig, parseMessage, toFindings } from './adapter.mjs';

// Real deptrac 4.7.2 JSON (smoke run, root mounted at /x), with --report-skipped
// and --report-uncovered so every message kind shows; the adapter passes neither.
const REPORT = {
  Report: { Violations: 1, 'Skipped violations': 1, Uncovered: 2, Allowed: 3, Warnings: 0, Errors: 0 },
  files: {
    '/x/src/Controller/SkippedController.php': {
      messages: [
        {
          message: 'App\\Controller\\SkippedController should not depend on App\\Repository\\UserRepository (Controller on Repository)',
          line: 8,
          type: 'warning',
        },
      ],
      violations: 1,
    },
    '/x/src/Domain/Uncovered.php': {
      messages: [
        { message: 'App\\Domain\\Uncovered has uncovered dependency on Vendor\\Lib\\Thing (Domain)', line: 8, type: 'warning' },
        { message: 'App\\Domain\\Uncovered has uncovered dependency on Vendor\\Lib\\Thing (Domain)', line: 8, type: 'warning' },
      ],
      violations: 2,
    },
    '/x/src/Controller/UserController.php': {
      messages: [
        {
          message: 'App\\Controller\\UserController must not depend on App\\Repository\\UserRepository (Controller on Repository)',
          line: 9,
          type: 'error',
        },
      ],
      violations: 1,
    },
    // deptrac reports one message per dependency occurrence: return type and `new` on one line.
    '/x/sub/src/A/Ay.php': {
      messages: [
        { message: 'Sub\\A\\Ay must not depend on Sub\\B\\Bee (A on B)', line: 8, type: 'error' },
        { message: 'Sub\\A\\Ay must not depend on Sub\\B\\Bee (A on B)', line: 8, type: 'error' },
      ],
      violations: 2,
    },
  },
};

const ALL = new Set([
  'src/Controller/SkippedController.php',
  'src/Domain/Uncovered.php',
  'src/Controller/UserController.php',
  'sub/src/A/Ay.php',
]);

describe('parseMessage', () => {
  it('splits a violation into classes and layers', () => {
    expect(parseMessage(REPORT.files['/x/src/Controller/UserController.php'].messages[0])).toMatchObject({
      kind: 'violation',
      depender: 'App\\Controller\\UserController',
      dependent: 'App\\Repository\\UserRepository',
      fromLayer: 'Controller',
      toLayer: 'Repository',
    });
  });
  it('tells skipped and uncovered apart from violations (both are type warning)', () => {
    expect(parseMessage(REPORT.files['/x/src/Controller/SkippedController.php'].messages[0]).kind).toBe('skipped');
    expect(parseMessage(REPORT.files['/x/src/Domain/Uncovered.php'].messages[0])).toMatchObject({
      kind: 'uncovered',
      dependent: 'Vendor\\Lib\\Thing',
      fromLayer: 'Domain',
      toLayer: undefined,
    });
  });
  it('falls back to the type for unknown wording', () => {
    expect(parseMessage({ message: 'something else', type: 'error' })).toEqual({ kind: 'violation', text: 'something else' });
    expect(parseMessage({ message: 'something else', type: 'warning' }).kind).toBe('other');
    expect(parseMessage(undefined).kind).toBe('other');
  });
});

describe('toFindings', () => {
  it('reports only violations, high, deduplicated, with repo-relative paths', () => {
    const findings = toFindings(REPORT, { root: '/x', wanted: ALL, config: 'deptrac.yaml' });
    expect(findings).toEqual([
      {
        ruleId: 'layer-violation',
        message:
          "App\\Controller\\UserController must not depend on App\\Repository\\UserRepository: deptrac.yaml's ruleset does not allow layer Controller to depend on layer Repository. Depend on an allowed layer instead, or change the ruleset.",
        file: 'src/Controller/UserController.php',
        line: 9,
        category: 'architecture',
        severity: 'high',
        helpUri: 'https://deptrac.github.io/deptrac/',
      },
      expect.objectContaining({ file: 'sub/src/A/Ay.php', line: 8, severity: 'high' }),
    ]);
  });
  it('keeps only files under review', () => {
    const findings = toFindings(REPORT, { root: '/x', wanted: new Set(['sub/src/A/Ay.php']), config: 'sub/deptrac.php' });
    expect(findings.map((f) => f.file)).toEqual(['sub/src/A/Ay.php']);
    expect(findings[0].message).toContain("sub/deptrac.php's ruleset does not allow layer A to depend on layer B");
  });
  it('survives odd input', () => {
    expect(toFindings({}, { root: '/x', wanted: ALL, config: 'deptrac.yaml' })).toEqual([]);
    expect(toFindings(undefined, { root: '/x', wanted: ALL, config: 'deptrac.yaml' })).toEqual([]);
    const odd = { files: { 'a.php': { messages: [{ message: 'weird', type: 'error' }] } } };
    expect(toFindings(odd, { root: '/x', wanted: new Set(['a.php']), config: 'deptrac.yaml' })).toEqual([
      expect.objectContaining({ file: 'a.php', line: 1, message: expect.stringMatching(/^weird: deptrac\.yaml's ruleset forbids/) }),
    ]);
  });
});

describe('countsNote', () => {
  it('notes errors and warnings only when there are some', () => {
    expect(countsNote(REPORT, 'deptrac.yaml')).toBeNull();
    expect(countsNote({ Report: { Errors: 2, Warnings: 1 } }, 'deptrac.yaml')).toBe(
      'deptrac (deptrac.yaml): 2 error(s), 1 warning(s); run `deptrac analyse` locally for details',
    );
  });
});

describe('config lookup', () => {
  const tree = new Set(['/r/deptrac.yaml', '/r/sub/deptrac.php', '/r/sub/deptrac.yaml', '/r/php/deptrac.php']);
  const exists = (p) => tree.has(p);

  it('finds the nearest config, preferring yaml', () => {
    expect(nearestConfig('/r', 'src/A.php', undefined, exists)).toBe('deptrac.yaml');
    expect(nearestConfig('/r', 'sub/src/deep/A.php', undefined, exists)).toBe('sub/deptrac.yaml');
    expect(nearestConfig('/r', 'php/A.php', undefined, exists)).toBe('php/deptrac.php');
    expect(nearestConfig('/r', 'A.php', undefined, () => false)).toBeNull();
  });
  it('groups only .php files by config', () => {
    const groups = groupByConfig('/r', ['src/A.php', 'sub/B.php', 'README.md', 'php/C.php', 'src/D.php'], exists);
    expect([...groups]).toEqual([
      ['deptrac.yaml', ['src/A.php', 'src/D.php']],
      ['sub/deptrac.yaml', ['sub/B.php']],
      ['php/deptrac.php', ['php/C.php']],
    ]);
  });
});

describe('analyze', () => {
  let dir;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('notes and skips PHP files without a deptrac config, without running deptrac', async () => {
    dir = mkdtempSync(join(tmpdir(), 'deptrac-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/A.php'), '<?php\nclass A {}\n');
    writeFileSync(join(dir, 'b.js'), '');
    const result = await analyze({ root: dir, files: ['src/A.php', 'b.js', 'gone.php'] });
    expect(result.findings).toEqual([]);
    expect(result.notes).toEqual(['deptrac: no deptrac.yaml/deptrac.yml/deptrac.php at or above 1 changed PHP file(s); layer rules not checked']);
  });
  it('does nothing without PHP files', async () => {
    dir = mkdtempSync(join(tmpdir(), 'deptrac-'));
    expect(await analyze({ root: dir, files: ['a.ts'] })).toEqual({ findings: [], notes: [] });
  });
});
