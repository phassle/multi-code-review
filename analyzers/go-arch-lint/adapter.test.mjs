import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyze,
  groupByModule,
  hasRequires,
  missingDeps,
  moduleRoot,
  parseReport,
  parseVersion,
  reportNotes,
  toFindings,
} from './adapter.mjs';

// Real `go-arch-lint check --json --output-json-one-line` output (v1.19.1) from
// the smoke run: module at /x, domain imports infra, tools/x.go in no component.
const REAL = '{"Type":"models.Check","Payload":{"ExecutionWarnings":[],"ArchHasWarnings":true,"ArchWarningsDeps":[{"ComponentName":"domain","FileRelativePath":"/internal/domain/user.go","FileAbsolutePath":"/x/internal/domain/user.go","ResolvedImportName":"example.com/smoke/internal/infra","Reference":{"Valid":true,"File":"/x/internal/domain/user.go","Line":6,"Offset":2}}],"ArchWarningsNotMatched":[{"FileRelativePath":"/tools/x.go","FileAbsolutePath":"/x/tools/x.go"}],"ArchWarningsDeepScan":[],"OmittedCount":0,"ModuleName":"example.com/smoke","Qualities":[{"ID":"component_imports","Used":true},{"ID":"vendor_imports","Used":true},{"ID":"deepscan","Used":true}]}}';

// Shape from go-arch-lint's models.CheckArchWarningDeepscan (internal/models/opr_check.go).
const DEEP = {
  Type: 'models.Check',
  Payload: {
    ExecutionWarnings: [],
    ArchHasWarnings: true,
    ArchWarningsDeps: [],
    ArchWarningsNotMatched: [],
    ArchWarningsDeepScan: [
      {
        Gate: { ComponentName: 'domain', MethodName: 'NewService', Definition: { Valid: true, File: '/x/internal/domain/service.go', Line: 9, Offset: 17 } },
        Dependency: { ComponentName: 'infra', Name: 'infra.DB', InjectionAST: 'infra.NewDB()', Injection: { Valid: true, File: '/x/cmd/app/main.go', Line: 11, Offset: 27 } },
        Target: { Definition: { Valid: true, File: '/x/internal/infra/store.go', Line: 3, Offset: 6 } },
      },
    ],
    OmittedCount: 0,
  },
};

describe('parseReport / parseVersion', () => {
  it('reads the check payload', () => {
    expect(parseReport(REAL).Payload.ModuleName).toBe('example.com/smoke');
  });
  it('rejects plain-text errors and other payloads', () => {
    expect(parseReport("failed to assemble project info: not found archfile in '/x/.go-arch-lint.yml'")).toBeUndefined();
    expect(parseReport('{"Type":"models.Version","Payload":{}}')).toBeUndefined();
    expect(parseReport('')).toBeUndefined();
  });
  it('takes the version from version --json', () => {
    expect(parseVersion('{"Type":"models.Version","Payload":{"LinterVersion":"1.19.1","GoArchFileSupported":"1 .. 3"}}')).toBe('1.19.1');
    expect(parseVersion('')).toBe('go-arch-lint');
  });
});

describe('toFindings', () => {
  const opts = { root: '/x', mod: '/x' };

  it('maps dependency and not-matched warnings from the real report', () => {
    const f = toFindings(parseReport(REAL), { ...opts, wanted: ['internal/domain/user.go', 'tools/x.go'] });
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ ruleId: 'deps', file: 'internal/domain/user.go', line: 6, column: 2, severity: 'high', category: 'architecture' });
    expect(f[0].message).toContain("'domain'");
    expect(f[0].message).toContain('example.com/smoke/internal/infra');
    expect(f[1]).toMatchObject({ ruleId: 'not-matched', file: 'tools/x.go', line: 1, severity: 'medium' });
  });

  it('keeps only files under review', () => {
    expect(toFindings(parseReport(REAL), { ...opts, wanted: ['cmd/app/main.go'] })).toEqual([]);
    expect(toFindings(parseReport(REAL), { ...opts, wanted: ['./tools/x.go'] }).map((x) => x.ruleId)).toEqual(['not-matched']);
  });

  it('makes paths relative to the repo root for a nested module', () => {
    const json = parseReport(REAL.replaceAll('/x/', '/repo/svc/'));
    const f = toFindings(json, { root: '/repo', mod: '/repo/svc', wanted: ['svc/internal/domain/user.go', 'svc/tools/x.go'] });
    expect(f.map((x) => x.file)).toEqual(['svc/internal/domain/user.go', 'svc/tools/x.go']);
  });

  it('falls back to the file path when the reference is invalid', () => {
    const json = parseReport(REAL);
    json.Payload.ArchWarningsDeps[0].Reference = { Valid: false, File: '', Line: 0, Offset: 0 };
    const [f] = toFindings(json, { ...opts, wanted: ['internal/domain/user.go'] });
    expect(f).toMatchObject({ file: 'internal/domain/user.go', line: 1 });
    expect(f.column).toBeUndefined();
  });

  it('reports a deep-scan warning at the injection', () => {
    const [f] = toFindings(DEEP, { ...opts, wanted: ['cmd/app/main.go', 'internal/domain/service.go'] });
    expect(f).toMatchObject({ ruleId: 'deep-scan', file: 'cmd/app/main.go', line: 11, column: 27, severity: 'high' });
    expect(f.message).toContain("'domain'");
    expect(f.message).toContain("'infra'");
    expect(f.message).toContain('infra.NewDB()');
    expect(f.message).toContain('NewService');
    expect(toFindings(DEEP, { ...opts, wanted: ['internal/domain/service.go'] })).toEqual([]);
  });

  it('dedupes and tolerates empty payloads', () => {
    const json = parseReport(REAL);
    json.Payload.ArchWarningsDeps.push(json.Payload.ArchWarningsDeps[0]);
    expect(toFindings(json, { ...opts, wanted: ['internal/domain/user.go'] })).toHaveLength(1);
    expect(toFindings({}, { ...opts, wanted: ['a.go'] })).toEqual([]);
  });
});

describe('reportNotes', () => {
  it('passes arch file problems and truncation on', () => {
    const notes = reportNotes(
      { Payload: { ExecutionWarnings: [{ Text: "should have ref in 'mayDependOn'/'canUse'", File: '/x/svc/.go-arch-lint.yml', Line: 11, Offset: 5 }], OmittedCount: 3 } },
      { root: '/x', mod: '/x/svc' },
    );
    expect(notes).toEqual([
      "go-arch-lint (svc): should have ref in 'mayDependOn'/'canUse' (svc/.go-arch-lint.yml:11)",
      'go-arch-lint (svc): 3 warnings omitted; findings may be incomplete',
    ]);
    expect(reportNotes(parseReport(REAL), { root: '/x', mod: '/x' })).toEqual([]);
  });
});

describe('modules', () => {
  const fs = (paths) => (p) => paths.includes(p);

  it('finds the nearest go.mod, not above root', () => {
    expect(moduleRoot('/r', '/r/svc/internal/a', fs(['/r/svc/go.mod', '/r/go.mod']))).toBe('/r/svc');
    expect(moduleRoot('/r', '/r/a', fs(['/go.mod']))).toBeUndefined();
  });

  it('groups .go files by module and lists orphans', () => {
    const { groups, orphans } = groupByModule('/r', ['svc/a.go', 'svc/b/c.go', 'x.go', 'README.md'], fs(['/r/svc/go.mod']));
    expect([...groups]).toEqual([['/r/svc', ['svc/a.go', 'svc/b/c.go']]]);
    expect(orphans).toEqual(['x.go']);
  });

  it('sees requires in go.mod', () => {
    expect(hasRequires('module m\n\ngo 1.24\n')).toBe(false);
    expect(hasRequires('module m\n\nrequire github.com/a/b v1.0.0\n')).toBe(true);
    expect(hasRequires('module m\nrequire (\n\tgithub.com/a/b v1.0.0\n)\n')).toBe(true);
  });

  it('recognises offline load errors', () => {
    expect(missingDeps('go: github.com/a/b@v1.0.0: module lookup disabled by GOPROXY=off')).toBe(true);
    expect(missingDeps("not found archfile in '/x/.go-arch-lint.yml'")).toBe(false);
  });
});

describe('analyze (without go-arch-lint)', () => {
  let dir;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('skips non-Go files', async () => {
    expect(await analyze({ root: '/nowhere', files: ['a.ts'] })).toEqual({ findings: [], notes: [] });
  });

  it('notes modules without .go-arch-lint.yml and files without go.mod', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gal-'));
    mkdirSync(join(dir, 'svc/pkg'), { recursive: true });
    writeFileSync(join(dir, 'svc/go.mod'), 'module m\n');
    writeFileSync(join(dir, 'svc/pkg/a.go'), 'package pkg\n');
    writeFileSync(join(dir, 'loose.go'), 'package main\n');
    const r = await analyze({ root: dir, files: ['svc/pkg/a.go', 'loose.go'] });
    expect(r.findings).toEqual([]);
    expect(r.notes).toEqual([
      'go-arch-lint: no go.mod found for loose.go',
      'go-arch-lint (svc): no .go-arch-lint.yml next to go.mod; architecture not checked',
    ]);
  });
});
