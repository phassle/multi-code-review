import { describe, expect, it } from 'vitest';
import { defaultConfig, findImportLine, groupByProject, messageFor, nearestWith, severityOf, toFindings } from './adapter.mjs';

const dep = (module, resolved, extra = {}) => ({ module, resolved, dependencyTypes: ['local', 'import'], valid: true, ...extra });
const warn = (name) => ({ severity: 'warn', name });

// Trimmed depcruise 18 json: a.js <-> b.js cycle, b.js imports undeclared lodash and a missing file.
// summary.violations names the cycle once (from a.js); modules carry it for both.
const RESULT = {
  modules: [
    {
      source: 'src/a.js',
      dependencies: [
        dep('leftpad', 'node_modules/leftpad/index.js', { dependencyTypes: ['npm', 'import'] }),
        dep('./b.js', 'src/b.js', { circular: true, valid: false, rules: [warn('no-circular')], cycle: [{ name: 'src/b.js' }, { name: 'src/a.js' }] }),
      ],
    },
    {
      source: 'src/b.js',
      dependencies: [
        dep('./a.js', 'src/a.js', { circular: true, valid: false, rules: [warn('no-circular')], cycle: [{ name: 'src/a.js' }, { name: 'src/b.js' }] }),
        dep('./nope.js', './nope.js', { couldNotResolve: true, dependencyTypes: ['unknown'], valid: false, rules: [warn('not-to-unresolvable')] }),
        dep('lodash', 'node_modules/lodash/index.js', { dependencyTypes: ['npm-no-pkg', 'import'], valid: false, rules: [warn('no-non-package-json')] }),
        dep('ghost', 'ghost', { couldNotResolve: true, dependencyTypes: ['unknown'], valid: false, rules: [{ severity: 'error', name: 'not-to-unresolvable' }] }),
      ],
    },
    { source: 'node_modules/lodash/index.js', dependencies: [] },
  ],
  summary: {
    violations: [
      { type: 'cycle', from: 'src/a.js', to: 'src/b.js', rule: warn('no-circular'), cycle: [{ name: 'src/b.js' }, { name: 'src/a.js' }] },
      { type: 'module', from: 'src/orphan.js', to: 'src/orphan.js', rule: { severity: 'info', name: 'no-orphans' } },
    ],
    ruleSetUsed: { forbidden: [{ name: 'no-circular', to: { circular: true } }] },
  },
};

const SOURCES = {
  'src/a.js': "// a\nimport pad from 'leftpad';\nimport { b } from './b.js';\nexport const a = () => b() + pad;\n",
  'src/b.js': "import _ from \"lodash\";\nimport { a } from './a.js';\nimport missing from './nope.js';\nconst g = require('ghost');\n",
};

describe('severityOf', () => {
  it('maps depcruise severities', () => {
    expect(severityOf('error')).toBe('high');
    expect(severityOf('warn')).toBe('medium');
    expect(severityOf('info')).toBe('low');
    expect(severityOf('ignore')).toBeNull();
    expect(severityOf(undefined)).toBeNull();
  });
});

describe('findImportLine', () => {
  it('finds the import of the specifier as written, any quote style', () => {
    expect(findImportLine(SOURCES['src/a.js'], './b.js')).toBe(3);
    expect(findImportLine(SOURCES['src/b.js'], 'lodash')).toBe(1);
    expect(findImportLine(SOURCES['src/b.js'], 'ghost')).toBe(4);
    expect(findImportLine('const m = await import(`./x`);', './x')).toBe(1);
  });
  it('handles multi-line imports (the from line)', () => {
    expect(findImportLine("import {\n  a,\n  b,\n} from './ab';\n", './ab')).toBe(4);
  });
  it('does not match a longer specifier', () => {
    expect(findImportLine("import x from './b.json';\nimport y from './b';\n", './b')).toBe(2);
  });
  it('prefers an import line over a plain string, falls back to 1', () => {
    expect(findImportLine("const s = './y';\nexport * from './y';\n", './y')).toBe(2);
    expect(findImportLine("const s = './y';\n", './y')).toBe(1);
    expect(findImportLine('nothing here', './z')).toBe(1);
    expect(findImportLine('x', undefined)).toBe(1);
  });
});

describe('toFindings', () => {
  const read = (f) => SOURCES[f] ?? null;

  it('maps every rule hit in the files under review to its import line', () => {
    const findings = toFindings(RESULT, { wanted: new Set(['src/a.js', 'src/b.js']), read });
    expect(findings.map((f) => [f.ruleId, f.file, f.line, f.severity])).toEqual([
      ['no-circular', 'src/a.js', 3, 'medium'],
      ['no-circular', 'src/b.js', 2, 'medium'],
      ['not-to-unresolvable', 'src/b.js', 3, 'medium'],
      ['no-non-package-json', 'src/b.js', 1, 'medium'],
      ['not-to-unresolvable', 'src/b.js', 4, 'high'],
    ]);
    expect(findings[0].message).toContain('src/a.js -> src/b.js -> src/a.js');
    expect(findings[3].message).toContain("'lodash'");
    expect(findings.every((f) => f.category === 'architecture' && f.helpUri.includes('dependency-cruiser'))).toBe(true);
  });

  it('reports only files under review (a cycle through b.js, only b.js changed)', () => {
    const findings = toFindings(RESULT, { wanted: new Set(['src/b.js']), read });
    expect(findings.filter((f) => f.ruleId === 'no-circular').map((f) => f.file)).toEqual(['src/b.js']);
    expect(findings.some((f) => f.file === 'src/a.js')).toBe(false);
  });

  it('drops unresolvable bare packages without node_modules, keeps relative ones', () => {
    const findings = toFindings(RESULT, { wanted: new Set(['src/b.js']), read, bareUnresolvable: false });
    const unresolvable = findings.filter((f) => f.ruleId === 'not-to-unresolvable');
    expect(unresolvable.map((f) => f.line)).toEqual([3]);
  });

  it('drops unresolvable bare packages under a repo rule name too', () => {
    const r = { modules: [{ source: 'a.js', dependencies: [dep('react', 'react', { couldNotResolve: true, valid: false, rules: [{ severity: 'error', name: 'strict' }] })] }] };
    expect(toFindings(r, { wanted: new Set(['a.js']), bareUnresolvable: false })).toEqual([]);
    expect(toFindings(r, { wanted: new Set(['a.js']) })).toHaveLength(1);
  });

  it('prefixes the project dir and takes module-level rules from the summary on line 1', () => {
    const findings = toFindings(RESULT, { project: 'web', wanted: new Set(['web/src/orphan.js', 'web/src/a.js']), read: () => null });
    expect(findings.map((f) => [f.ruleId, f.file, f.line, f.severity])).toEqual([
      ['no-circular', 'web/src/a.js', 1, 'medium'],
      ['no-orphans', 'web/src/orphan.js', 1, 'low'],
    ]);
  });

  it('skips ignore-severity rules and empty results', () => {
    const r = { modules: [{ source: 'a.js', dependencies: [dep('./b', 'b.js', { valid: false, rules: [{ severity: 'ignore', name: 'x' }] })] }] };
    expect(toFindings(r, { wanted: new Set(['a.js']) })).toEqual([]);
    expect(toFindings({}, { wanted: new Set(['a.js']) })).toEqual([]);
  });

  it('gives a repo rule on a circular import its own message', () => {
    const r = {
      modules: [{ source: 'a.js', dependencies: [dep('./b', 'b.js', { circular: true, cycle: [{ name: 'b.js' }], valid: false, rules: [{ severity: 'error', name: 'no-ui-to-db' }] })] }],
      summary: { ruleSetUsed: { forbidden: [{ name: 'no-ui-to-db', to: { path: 'db' } }] } },
    };
    const [f] = toFindings(r, { wanted: new Set(['a.js']), read: () => "import b from './b';" });
    expect(f).toMatchObject({ ruleId: 'no-ui-to-db', severity: 'high', line: 1 });
    expect(f.message).not.toContain('Circular');
  });
});

describe('messageFor', () => {
  it('accepts cycles as strings (older depcruise)', () => {
    expect(messageFor('no-circular', { from: 'a.js', cycle: ['b.js', 'a.js'] })).toContain('a.js -> b.js -> a.js');
  });
});

describe('projects and configs', () => {
  const tree = new Set(['package.json', 'web/package.json', 'web/.dependency-cruiser.json', '.dependency-cruiser.cjs']);
  const exists = (p) => tree.has(p.replace(/^root\//, ''));

  it('groups cruisable files by nearest package.json', () => {
    const groups = groupByProject('root', ['web/src/a.ts', 'web/b.tsx', 'lib/c.mjs', 'README.md', 'x.css'], exists);
    expect([...groups]).toEqual([
      ['web', ['web/src/a.ts', 'web/b.tsx']],
      ['', ['lib/c.mjs']],
    ]);
  });

  it('finds the nearest config upwards', () => {
    const names = ['.dependency-cruiser.json', '.dependency-cruiser.js', '.dependency-cruiser.cjs', '.dependency-cruiser.mjs'];
    expect(nearestWith('root', 'web/x', names, exists)).toEqual({ dir: 'web', name: '.dependency-cruiser.json' });
    expect(nearestWith('root', 'lib/x', names, exists)).toEqual({ dir: '', name: '.dependency-cruiser.cjs' });
    expect(nearestWith('root', 'x', ['nope'], exists)).toBeNull();
  });

  it('default config: three warn rules, tsconfig only when given', () => {
    const c = defaultConfig('/r/tsconfig.json');
    expect(c.forbidden.map((r) => [r.name, r.severity])).toEqual([
      ['no-circular', 'warn'],
      ['not-to-unresolvable', 'warn'],
      ['no-non-package-json', 'warn'],
    ]);
    expect(c.options.tsConfig).toEqual({ fileName: '/r/tsconfig.json' });
    expect(defaultConfig(null).options.tsConfig).toBeUndefined();
  });
});
