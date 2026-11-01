import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RULES,
  analyze,
  findKeyLine,
  findWordLine,
  groupByProject,
  isWorkspaceRoot,
  knipArgs,
  packageDir,
  parseOutput,
  toFindings,
} from './adapter.mjs';

const empty = {
  binaries: [], cycles: [], dependencies: [], devDependencies: [], duplicates: [], enumMembers: [], exports: [], files: [],
  namespaceMembers: [], nsExports: [], nsTypes: [], optionalPeerDependencies: [], types: [], unlisted: [], unresolved: [],
};
const issue = (file, extra) => ({ file, ...empty, ...extra });

// knip 6.44.1 `--reporter json` on the smoke fixture (single package).
const RESULT = {
  issues: [
    issue('src/orphan.js', { files: [{ name: 'src/orphan.js' }] }),
    issue('package.json', {
      binaries: [{ name: 'eslint' }, { name: 'prettier' }],
      dependencies: [{ name: 'unused-pkg', line: 8, col: 6, pos: 143 }],
      devDependencies: [{ name: 'unused-dev', line: 11, col: 6, pos: 197 }],
    }),
    issue('src/index.js', {
      unlisted: [{ name: 'chalk', line: 2, col: 19, pos: 45 }],
      unresolved: [{ name: './missing.js', line: 4, col: 21, pos: 107 }],
    }),
    issue('src/lib.js', { exports: [{ name: 'unusedFn', line: 5, col: 17, pos: 58 }] }),
    issue('src/types.ts', {
      enumMembers: [{ namespace: 'Color', name: 'Green', line: 2, col: 26, pos: 61 }],
      exports: [{ name: 'Klass', line: 3, col: 14, pos: 82 }],
      types: [{ name: 'Unused', line: 1, col: 13, pos: 12 }],
      cycles: [{ name: 'whatever', line: 1 }],
    }),
    issue('src/ns.js', { exports: [{ namespace: 'ns', name: 'b', line: 2, col: 14, pos: 33 }] }),
  ],
};

// Monorepo run from the workspace root with --workspace: no line for workspace package.json deps.
const MONO = {
  issues: [
    issue('packages/a/src/orphan.js', { files: [{ name: 'packages/a/src/orphan.js' }] }),
    issue('packages/a/package.json', { dependencies: [{ name: 'gone' }] }),
  ],
};

const PKG = `{
  "name": "knip-smoke",
  "version": "1.0.0",
  "type": "module",
  "main": "src/index.js",
  "dependencies": {
    "leftpad": "1.0.0",
    "unused-pkg": "1.0.0"
  },
  "devDependencies": {
    "unused-dev": "1.0.0"
  },
  "scripts": {
    "lint": "eslint .",
    "fmt": "prettier --write ."
  }
}
`;

describe('findKeyLine', () => {
  it('finds the JSON key line, not a value or a longer key', () => {
    const src = '{\n  "x": "gone",\n  "gone-too": "1",\n  "gone" : "1"\n}';
    expect(findKeyLine(src, 'gone')).toBe(4);
    expect(findKeyLine(src, 'nope')).toBe(0);
  });
});

describe('findWordLine', () => {
  it('finds a binary as a whole word in a script', () => {
    expect(findWordLine(PKG, 'eslint')).toBe(14);
    expect(findWordLine(PKG, 'prettier')).toBe(15);
    expect(findWordLine('"a": "eslint-config x"\n"b": "npx eslint ."', 'eslint')).toBe(2);
    expect(findWordLine(PKG, 'tsc')).toBe(0);
  });
});

describe('toFindings', () => {
  const read = (f) => (f.endsWith('package.json') ? PKG : null);
  const all = new Set(RESULT.issues.map((i) => i.file));

  it('maps each issue type to a rule, line and severity; never high', () => {
    const findings = toFindings(RESULT, { wanted: all, read });
    expect(findings.map((f) => [f.ruleId, f.file, f.line, f.column, f.severity])).toEqual([
      ['unused-file', 'src/orphan.js', 1, undefined, 'medium'],
      ['unused-dependency', 'package.json', 8, 6, 'medium'],
      ['unused-dev-dependency', 'package.json', 11, 6, 'low'],
      ['unlisted-binary', 'package.json', 14, undefined, 'medium'],
      ['unlisted-binary', 'package.json', 15, undefined, 'medium'],
      ['unlisted-dependency', 'src/index.js', 2, 19, 'medium'],
      ['unresolved-import', 'src/index.js', 4, 21, 'medium'],
      ['unused-export', 'src/lib.js', 5, 17, 'medium'],
      ['unused-export', 'src/types.ts', 3, 14, 'medium'],
      ['unused-type', 'src/types.ts', 1, 13, 'low'],
      ['unused-enum-member', 'src/types.ts', 2, 26, 'low'],
      ['unused-export', 'src/ns.js', 2, 14, 'medium'],
    ]);
    expect(findings.every((f) => f.category === 'best-practices' && f.helpUri)).toBe(true);
    expect(Object.values(RULES).some((r) => r.severity === 'high')).toBe(false);
  });

  it('writes messages that name the symbol', () => {
    const findings = toFindings(RESULT, { wanted: all, read });
    const msg = (rule, file) => findings.find((f) => f.ruleId === rule && f.file === file).message;
    expect(msg('unused-file', 'src/orphan.js')).toContain('src/orphan.js');
    expect(msg('unused-enum-member', 'src/types.ts')).toContain("'Color.Green'");
    expect(msg('unused-export', 'src/ns.js')).toContain("namespace 'ns'");
    expect(msg('unlisted-dependency', 'src/index.js')).toContain("'chalk'");
  });

  it('keeps only files under review', () => {
    const findings = toFindings(RESULT, { wanted: new Set(['src/lib.js']), read });
    expect(findings.map((f) => f.file)).toEqual(['src/lib.js']);
    expect(toFindings(RESULT, { wanted: new Set(['src/other.js']), read })).toEqual([]);
  });

  it('prefixes the run dir and finds package.json keys knip gives no line for', () => {
    const pkg = '{\n  "name": "a",\n  "dependencies": {\n    "gone": "1"\n  }\n}';
    const findings = toFindings(MONO, {
      project: 'mono',
      wanted: new Set(['mono/packages/a/src/orphan.js', 'mono/packages/a/package.json']),
      read: (f) => (f === 'mono/packages/a/package.json' ? pkg : null),
    });
    expect(findings.map((f) => [f.ruleId, f.file, f.line])).toEqual([
      ['unused-file', 'mono/packages/a/src/orphan.js', 1],
      ['unused-dependency', 'mono/packages/a/package.json', 4],
    ]);
    expect(findings[0].message).toContain('mono/packages/a/src/orphan.js');
  });

  it('falls back to line 1 and handles duplicates as symbol lists', () => {
    const result = { issues: [{ file: 'a.ts', duplicates: [[{ name: 'x', line: 3, col: 1 }, { name: 'default', line: 4 }]] }] };
    const [f] = toFindings(result, { wanted: new Set(['a.ts']) });
    expect([f.ruleId, f.line, f.severity]).toEqual(['duplicate-export', 3, 'low']);
    expect(f.message).toContain('x, default');
    const [g] = toFindings({ issues: [issue('package.json', { dependencies: [{ name: 'q' }] })] }, { wanted: new Set(['package.json']) });
    expect(g.line).toBe(1);
  });

  it('survives junk', () => {
    expect(toFindings(null, { wanted: new Set() })).toEqual([]);
    expect(toFindings({ issues: [{ file: 1 }, { file: 'a.js', exports: [{}] }] }, { wanted: new Set(['a.js']) })).toEqual([]);
  });
});

describe('parseOutput', () => {
  it('parses the json, also after stray plugin output', () => {
    expect(parseOutput('{"issues":[]}')).toEqual({ issues: [] });
    expect(parseOutput('warning from a plugin\n{"issues":[]}\n')).toEqual({ issues: [] });
    expect(parseOutput('Error: config failed')).toBeNull();
  });
});

describe('knipArgs', () => {
  it('filters workspaces only in a monorepo', () => {
    expect(knipArgs(new Set(['.']), false)).not.toContain('--workspace');
    const args = knipArgs(new Set(['packages/b', '.']), true);
    expect(args.slice(0, 6)).toEqual(['--reporter', 'json', '--no-progress', '--no-exit-code', '--no-config-hints', '--no-tag-hints']);
    expect(args.slice(6)).toEqual(['--workspace', '.', '--workspace', 'packages/b']);
  });
});

describe('projects', () => {
  const FILES = {
    'package.json': '{"name":"r"}',
    'mono/package.json': '{"workspaces":["packages/*"]}',
    'mono/packages/a/package.json': '{"name":"a"}',
    'mono/packages/b/package.json': '{"name":"b"}',
    'pn/pnpm-workspace.yaml': 'packages: [x]',
    'pn/package.json': '{}',
    'pn/x/package.json': '{}',
    'yarn/package.json': '{"workspaces":{"packages":["p/*"]}}',
    'app/package.json': '{"workspaces":[]}',
  };
  const exists = (p) => p.slice(6) in FILES;
  const read = (p) => FILES[p.slice(6)] ?? null;
  const opts = { exists, read };

  it('finds the nearest package.json dir', () => {
    expect(packageDir('/repo', 'mono/packages/a/src/x.ts', exists)).toBe('mono/packages/a');
    expect(packageDir('/repo', 'src/x.ts', exists)).toBe('');
    expect(packageDir('/repo', 'x.ts', () => false)).toBeNull();
  });

  it('recognises workspace roots', () => {
    expect(isWorkspaceRoot('/repo', 'mono', opts)).toBe(true);
    expect(isWorkspaceRoot('/repo', 'pn', opts)).toBe(true);
    expect(isWorkspaceRoot('/repo', 'yarn', opts)).toBe(true);
    expect(isWorkspaceRoot('/repo', 'app', opts)).toBe(false);
    expect(isWorkspaceRoot('/repo', '', opts)).toBe(false);
  });

  it('groups by workspace root with relative workspace filters; skips irrelevant files', () => {
    const groups = groupByProject(
      '/repo',
      ['mono/packages/a/src/x.ts', 'mono/packages/b/package.json', 'mono/tool.js', 'pn/x/y.js', 'app/src/z.tsx', 'src/i.js', 'README.md', 'mono/packages/a/notes.txt'],
      opts,
    );
    const plain = Object.fromEntries([...groups].map(([k, g]) => [k, { workspaces: [...g.workspaces].sort(), files: g.files }]));
    expect(plain).toEqual({
      mono: { workspaces: ['.', 'packages/a', 'packages/b'], files: ['mono/packages/a/src/x.ts', 'mono/packages/b/package.json', 'mono/tool.js'] },
      pn: { workspaces: ['x'], files: ['pn/x/y.js'] },
      app: { workspaces: ['.'], files: ['app/src/z.tsx'] },
      '': { workspaces: ['.'], files: ['src/i.js'] },
    });
  });
});

describe('analyze', () => {
  let dir;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('skips a project without node_modules, with a note', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
    writeFileSync(join(dir, 'src/a.js'), 'export const a = 1;\n');
    const { findings, notes } = await analyze({ root: dir, files: ['src/a.js', 'README.md'] });
    expect(findings).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('no node_modules');
  });

  it('does nothing for files outside any package', async () => {
    dir = mkdtempSync(join(tmpdir(), 'knip-'));
    expect(await analyze({ root: dir, files: ['a.js'] })).toEqual({ findings: [], notes: [] });
  });
});
