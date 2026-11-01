import { describe, expect, it } from 'vitest';
import { enforcement, groupByRoot, packwerkRoot, severity, toFindings, yamlValue } from './adapter.mjs';

// Shape of `pks check --json` (pks 0.2.40); columns are 0-based.
const REPORT = {
  status: 'failure',
  violations: [
    {
      message: 'packs/foo/app/services/foo.rb:3:4\nDependency violation: `::Bar` belongs to `packs/bar`, but `packs/foo/package.yml` does not specify a dependency on `packs/bar`.',
      file: 'packs/foo/app/services/foo.rb',
      line: 3,
      column: 4,
      violation_type: 'dependency',
      strict: false,
      constant_name: '::Bar',
      referencing_pack_name: 'packs/foo',
      defining_pack_name: 'packs/bar',
    },
    {
      message: 'packs/foo/app/services/foo.rb:5:4\nPrivacy violation: `::Bar::Secret` is private to `packs/bar`.',
      file: 'packs/foo/app/services/foo.rb',
      line: 5,
      column: 4,
      violation_type: 'privacy',
      strict: false,
      constant_name: '::Bar::Secret',
      referencing_pack_name: 'packs/foo',
      defining_pack_name: 'packs/bar',
    },
    {
      message: 'packs/baz/app/models/baz.rb:1:0\nDependency violation',
      file: 'packs/baz/app/models/baz.rb',
      line: 1,
      column: 0,
      violation_type: 'dependency',
      strict: true,
      constant_name: '::Foo',
      referencing_pack_name: 'packs/baz',
      defining_pack_name: 'packs/foo',
    },
  ],
  stale_violations: [],
  strict_mode_violations: [],
};

const PACKAGES = {
  'packs/foo': 'enforce_dependencies: true\nenforce_privacy: false\ndependencies:\n  - packs/qux\n',
  'packs/bar': "enforce_dependencies: false\nenforce_privacy: 'strict' # no exceptions\n",
  'packs/baz': 'enforce_dependencies: strict\n',
};
const read = (pack) => PACKAGES[pack] ?? null;

describe('yamlValue / enforcement', () => {
  it('reads top-level scalars, unquoted, without comments', () => {
    expect(yamlValue(PACKAGES['packs/bar'], 'enforce_privacy')).toBe('strict');
    expect(yamlValue(PACKAGES['packs/foo'], 'enforce_dependencies')).toBe('true');
    expect(yamlValue(PACKAGES['packs/foo'], 'enforce_layers')).toBeUndefined();
  });
  it('ignores nested keys', () => {
    expect(yamlValue('metadata:\n  enforce_privacy: true\n', 'enforce_privacy')).toBeUndefined();
  });
  it('maps violation types to their enforce_* key, with the deprecated folder_visibility name', () => {
    expect(enforcement(PACKAGES['packs/foo'], 'dependency')).toBe('true');
    expect(enforcement('enforce_folder_visibility: true\n', 'folder_privacy')).toBe('true');
    expect(enforcement('enforce_folder_privacy: false\nenforce_folder_visibility: true\n', 'folder_privacy')).toBe('false');
    expect(enforcement(null, 'dependency')).toBeUndefined();
    expect(enforcement('enforce_x: true', 'unknown')).toBeUndefined();
  });
});

describe('severity', () => {
  it('dependency uses the referencing pack', () => {
    expect(severity(REPORT.violations[0], read)).toBe('high');
    expect(severity({ ...REPORT.violations[0], referencing_pack_name: 'packs/bar' }, read)).toBe('medium');
  });
  it('privacy uses the defining pack', () => {
    expect(severity(REPORT.violations[1], read)).toBe('high');
    expect(severity({ ...REPORT.violations[1], defining_pack_name: 'packs/foo' }, read)).toBe('medium');
  });
  it('strict from pks is high; missing package.yml is medium', () => {
    expect(severity({ ...REPORT.violations[0], strict: true, referencing_pack_name: 'packs/none' }, read)).toBe('high');
    expect(severity({ ...REPORT.violations[0], referencing_pack_name: 'packs/none' }, read)).toBe('medium');
  });
});

describe('toFindings', () => {
  it('maps violations in the requested files, relative to the review root', () => {
    const findings = toFindings(REPORT, {
      root: '/repo',
      pkRoot: '/repo',
      files: ['packs/foo/app/services/foo.rb'],
      readPackageYml: read,
    });
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      ruleId: 'dependency',
      file: 'packs/foo/app/services/foo.rb',
      line: 3,
      column: 5,
      category: 'architecture',
      severity: 'high',
      ruleName: 'Undeclared pack dependency',
    });
    expect(findings[0].message).toContain('::Bar belongs to packs/bar and is referenced from packs/foo');
    expect(findings[0].message).toContain('packs/foo/package.yml');
    expect(findings[1]).toMatchObject({ ruleId: 'privacy', severity: 'high', line: 5 });
  });

  it('rebases paths when the packwerk root is a subdirectory', () => {
    const findings = toFindings(REPORT, {
      root: '/repo',
      pkRoot: '/repo/app',
      files: ['app/packs/baz/app/models/baz.rb'],
      readPackageYml: read,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: 'app/packs/baz/app/models/baz.rb', line: 1, column: 1, severity: 'high' });
  });

  it('handles an empty or clean report', () => {
    expect(toFindings({ status: 'success', violations: [] }, { root: '/r', pkRoot: '/r', files: ['a.rb'], readPackageYml: read })).toEqual([]);
    expect(toFindings(undefined, { root: '/r', pkRoot: '/r', files: ['a.rb'], readPackageYml: read })).toEqual([]);
  });
});

describe('packwerk roots', () => {
  const configs = new Set(['/repo/packwerk.yml', '/repo/engines/x/packs.yml', '/packwerk.yml']);
  const exists = (p) => configs.has(p);

  it('finds the nearest ancestor with a config, not above the limit', () => {
    expect(packwerkRoot('/repo', 'packs/foo/app/a.rb', '/repo', exists)).toBe('/repo');
    expect(packwerkRoot('/repo', 'engines/x/app/b.rb', '/repo', exists)).toBe('/repo/engines/x');
    expect(packwerkRoot('/other', 'lib/c.rb', '/other', exists)).toBeNull();
  });

  it('may search above the review root up to the limit', () => {
    expect(packwerkRoot('/repo/packs/foo', 'app/a.rb', '/repo', exists)).toBe('/repo');
    expect(packwerkRoot('/repo/packs/foo', 'app/a.rb', '/repo/packs/foo', exists)).toBeNull();
  });

  it('groups files by root', () => {
    const { groups, outside } = groupByRoot('/repo', ['a.rb', 'engines/x/b.rb', 'packs/c.rb'], '/repo', (p) => p === '/repo/engines/x/packs.yml');
    expect([...groups.entries()]).toEqual([['/repo/engines/x', ['engines/x/b.rb']]]);
    expect(outside).toEqual(['a.rb', 'packs/c.rb']);
  });
});
