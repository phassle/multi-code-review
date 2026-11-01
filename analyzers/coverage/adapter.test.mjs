import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyze,
  detectFormat,
  findReports,
  isTestFile,
  mapPath,
  mergeLines,
  parseCobertura,
  parseGoCover,
  parseJacoco,
  parseLcov,
  parseSimpleCov,
  recordsFor,
  suffixScore,
  toFindings,
  uncoveredRanges,
} from './adapter.mjs';

const obj = (lines) => Object.fromEntries(lines);

const LCOV = `TN:
SF:src/a.ts
FN:1,f
DA:1,1
DA:2,0
DA:3,0,abc123
end_of_record
SF:/abs/src/b.ts
DA:5,4
end_of_record
`;

const COBERTURA = `<?xml version="1.0" ?>
<coverage line-rate="0.5" version="7.4">
  <sources>
    <source>/home/runner/work/app/app/src</source>
  </sources>
  <packages><package name="pkg"><classes>
    <class name="mod.py" filename="pkg/mod.py" line-rate="0.5">
      <methods/>
      <lines>
        <line number="1" hits="1"/>
        <line number="2" hits="0"/>
        <line number="4" hits="0" branch="true" condition-coverage="50% (1/2)"/>
      </lines>
    </class>
    <class name="Other" filename="pkg/a&amp;b.py"><lines><line number="7" hits="3"/></lines></class>
  </classes></package></packages>
</coverage>`;

// coverlet writes the same file once per class; methods repeat the lines.
const COVERLET = `<?xml version="1.0" encoding="utf-8"?>
<coverage line-rate="1" branch-rate="1" version="1.9" timestamp="1">
  <sources><source>C:\\agent\\_work\\1\\s\\</source></sources>
  <packages><package name="App"><classes>
    <class name="App.Calc" filename="src\\App\\Calc.cs">
      <methods><method name="Add"><lines><line number="10" hits="0" branch="False" /></lines></method></methods>
      <lines><line number="10" hits="0" branch="False" /><line number="11" hits="2" branch="False" /></lines>
    </class>
    <class name="App.Calc/Inner" filename="src\\App\\Calc.cs">
      <lines><line number="20" hits="0" branch="False" /><line number="10" hits="5" branch="False" /></lines>
    </class>
  </classes></package></packages>
</coverage>`;

const JACOCO = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd"><report name="app"><sessioninfo id="x" start="1" dump="2"/><package name="com/acme"><class name="com/acme/Foo" sourcefilename="Foo.java"><method name="bar" desc="()V" line="3"><counter type="LINE" missed="1" covered="0"/></method></class><sourcefile name="Foo.java"><line nr="3" mi="0" ci="4" mb="0" cb="0"/><line nr="4" mi="2" ci="0" mb="0" cb="0"/><line nr="6" mi="0" ci="0" mb="0" cb="0"/><counter type="LINE" missed="1" covered="1"/></sourcefile></package><package name=""><sourcefile name="Default.java"><line nr="1" mi="1" ci="0"/></sourcefile></package></report>`;

const GO = `mode: atomic
example.com/m/pkg/a.go:3.20,5.2 2 1
example.com/m/pkg/a.go:7.10,9.3 1 0
example.com/m/pkg/a.go:9.3,9.20 1 2
example.com/m/pkg/a.go:12.1,12.5 0 0
`;

const SIMPLECOV = JSON.stringify({
  RSpec: { coverage: { '/app/lib/x.rb': { lines: [null, 1, 0, 'ignored', 0] } }, timestamp: 1 },
  Minitest: { coverage: { '/app/lib/x.rb': [null, 0, 2, null, 0], '/app/lib/y.rb': [1] }, timestamp: 1 },
});

describe('parsers', () => {
  it('lcov: SF/DA records, checksum ignored', () => {
    const r = parseLcov(LCOV);
    expect(r.map((x) => x.path)).toEqual(['src/a.ts', '/abs/src/b.ts']);
    expect(obj(r[0].lines)).toEqual({ 1: 1, 2: 0, 3: 0 });
    expect(obj(r[1].lines)).toEqual({ 5: 4 });
  });

  it('cobertura (coverage.py): sources, filenames, entities', () => {
    const { sources, records } = parseCobertura(COBERTURA);
    expect(sources).toEqual(['/home/runner/work/app/app/src']);
    expect(records.map((x) => x.path)).toEqual(['pkg/mod.py', 'pkg/a&b.py']);
    expect(obj(records[0].lines)).toEqual({ 1: 1, 2: 0, 4: 0 });
  });

  it('cobertura (coverlet): one file across classes, hit wins', () => {
    const { sources, records } = parseCobertura(COVERLET);
    expect(sources).toEqual(['C:\\agent\\_work\\1\\s\\']);
    expect(records).toHaveLength(1);
    expect(obj(records[0].lines)).toEqual({ 10: 5, 11: 2, 20: 0 });
  });

  it('jacoco: package/sourcefile paths, ci as hits, lines without instructions skipped', () => {
    const r = parseJacoco(JACOCO);
    expect(r.map((x) => x.path)).toEqual(['com/acme/Foo.java', 'Default.java']);
    expect(obj(r[0].lines)).toEqual({ 3: 4, 4: 0 });
  });

  it('go: blocks expanded to lines, any hit wins, empty blocks skipped', () => {
    const r = parseGoCover(GO);
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe('example.com/m/pkg/a.go');
    expect(obj(r[0].lines)).toEqual({ 3: 1, 4: 1, 5: 1, 7: 0, 8: 0, 9: 2 });
    expect(parseGoCover('not a profile\n')).toEqual([]);
  });

  it('simplecov: both shapes, suites merged, non-numbers not executable', () => {
    const r = parseSimpleCov(SIMPLECOV);
    const x = r.find((a) => a.path === '/app/lib/x.rb');
    expect(obj(x.lines)).toEqual({ 2: 1, 3: 2, 5: 0 });
    expect(obj(r.find((a) => a.path === '/app/lib/y.rb').lines)).toEqual({ 1: 1 });
  });
});

describe('detectFormat', () => {
  it('by name and content', () => {
    expect(detectFormat('coverage/lcov.info', '')).toBe('lcov');
    expect(detectFormat('out/unit.lcov', '')).toBe('lcov');
    expect(detectFormat('coverage.xml', '<?xml?><coverage ')).toBe('cobertura');
    expect(detectFormat('TestResults/x/coverage.cobertura.xml', '<coverage ')).toBe('cobertura');
    expect(detectFormat('target/site/jacoco/jacoco.xml', JACOCO.slice(0, 300))).toBe('jacoco');
    expect(detectFormat('build/reports/jacoco/test/jacocoTestReport.xml', '<report name="x">')).toBe('jacoco');
    expect(detectFormat('cover.out', 'mode: set\n')).toBe('go');
    expect(detectFormat('pkg.coverprofile', 'mode: count\n')).toBe('go');
    expect(detectFormat('coverage.out', 'something else')).toBeNull();
    expect(detectFormat('coverage/.resultset.json', '{')).toBe('simplecov');
    expect(detectFormat('pom.xml', '<project>')).toBeNull();
  });
});

describe('mapPath', () => {
  const have = (...files) => (f) => files.includes(f);
  const root = '/repo';

  it('relative to the repo root, the report dir, or its parent', () => {
    expect(mapPath('src/a.ts', { root, reportDir: 'coverage' }, have('src/a.ts'))).toEqual({ file: 'src/a.ts' });
    expect(mapPath('src/a.ts', { root, reportDir: 'packages/x/coverage' }, have('packages/x/src/a.ts'))).toEqual({ file: 'packages/x/src/a.ts' });
    expect(mapPath('./a.py', { root, reportDir: 'svc' }, have('svc/a.py'))).toEqual({ file: 'svc/a.py' });
  });

  it('absolute paths inside root', () => {
    expect(mapPath('/repo/src/b.ts', { root, reportDir: '' }, have('src/b.ts'))).toEqual({ file: 'src/b.ts' });
  });

  it('cobertura source roots, local or foreign (CI) with Windows separators', () => {
    expect(mapPath('pkg/mod.py', { root, reportDir: '', sources: ['/repo/src'] }, have('src/pkg/mod.py'))).toEqual({ file: 'src/pkg/mod.py' });
    expect(mapPath('pkg/mod.py', { root, reportDir: '', sources: ['/home/runner/work/app/app/src'] }, have())).toEqual({
      suffix: '/home/runner/work/app/app/src/pkg/mod.py',
    });
    expect(mapPath('src\\App\\Calc.cs', { root, reportDir: '', sources: ['C:\\agent\\_work\\1\\s\\'] }, have())).toEqual({
      suffix: 'C:/agent/_work/1/s/src/App/Calc.cs',
    });
  });

  it('go module import paths', () => {
    const modules = [{ module: 'example.com/m', dir: 'backend' }];
    expect(mapPath('example.com/m/pkg/a.go', { root, reportDir: 'backend', modules }, have('backend/pkg/a.go'))).toEqual({ file: 'backend/pkg/a.go' });
    expect(mapPath('example.com/other/a.go', { root, reportDir: '', modules }, have())).toEqual({ suffix: 'example.com/other/a.go' });
  });

  it('unresolved jacoco package paths fall back to suffix', () => {
    expect(mapPath('com/acme/Foo.java', { root, reportDir: 'target/site/jacoco' }, have())).toEqual({ suffix: 'com/acme/Foo.java' });
  });
});

describe('suffix matching', () => {
  it('needs one side to be a whole trailing part of the other', () => {
    expect(suffixScore('src/main/java/com/acme/Foo.java', 'com/acme/Foo.java')).toBe(3);
    expect(suffixScore('src/pkg/mod.py', '/home/runner/work/app/app/src/pkg/mod.py')).toBe(3);
    expect(suffixScore('a/x/Foo.java', 'b/x/Foo.java')).toBe(0);
    expect(suffixScore('Foo.java', 'Bar.java')).toBe(0);
  });

  it('exact beats suffix; longest suffix wins', () => {
    const lines = new Map();
    const mapped = [
      { suffix: 'x/Foo.java', lines },
      { suffix: 'com/acme/Foo.java', lines },
      { file: 'other/Foo.java', lines },
    ];
    expect(recordsFor('src/main/java/com/acme/Foo.java', mapped)).toEqual([mapped[1]]);
    expect(recordsFor('other/Foo.java', mapped)).toEqual([mapped[2]]);
    expect(recordsFor('src/nothing.ts', mapped)).toEqual([]);
  });

  it('mergeLines: executable in any, hit in any', () => {
    expect(obj(mergeLines([new Map([[1, 0], [2, 0]]), new Map([[2, 3], [5, 0]])]))).toEqual({ 1: 0, 2: 3, 5: 0 });
  });
});

describe('uncoveredRanges', () => {
  // 1 hit, 2-3 miss, 4 not executable, 5 miss, 6 hit, 7 miss, 9 miss
  const lines = new Map([[1, 1], [2, 0], [3, 0], [5, 0], [6, 1], [7, 0], [9, 0]]);

  it('merges across non-executable lines, splits at covered ones', () => {
    expect(uncoveredRanges('all', lines)).toEqual([
      { from: 2, to: 5, count: 3 },
      { from: 7, to: 9, count: 2 },
    ]);
  });

  it('only changed lines; unchanged executable lines split', () => {
    expect(uncoveredRanges([[1, 2], [5, 6]], lines)).toEqual([
      { from: 2, to: 2, count: 1 },
      { from: 5, to: 5, count: 1 },
    ]);
    expect(uncoveredRanges([[1, 1], [6, 6]], lines)).toEqual([]);
    expect(uncoveredRanges([[7, 10]], lines)).toEqual([{ from: 7, to: 9, count: 2 }]);
  });

  it('findings: one per range, medium testing', () => {
    expect(toFindings('a.ts', [{ from: 2, to: 5, count: 3 }, { from: 9, to: 9, count: 1 }])).toEqual([
      expect.objectContaining({ ruleId: 'uncovered-change', message: '3 changed lines (2–5) are not run by any test.', file: 'a.ts', line: 2, endLine: 5, category: 'testing', severity: 'medium' }),
      expect.objectContaining({ message: '1 changed line (9) is not run by any test.', line: 9 }),
    ]);
    expect(toFindings('a.ts', [{ from: 9, to: 9, count: 1 }])[0].endLine).toBeUndefined();
  });
});

describe('isTestFile', () => {
  it.each(['src/a.test.ts', 'tests/x.py', 'pkg/a_test.go', 'test_mod.py', 'src/FooTest.java', 'App.Tests/CalcTests.cs', 'spec/x_spec.rb', 'a.spec.js'])('%s', (f) =>
    expect(isTestFile(f)).toBe(true),
  );
  it.each(['src/a.ts', 'pkg/latest.go', 'src/Contest.java'])('not %s', (f) => expect(isTestFile(f)).toBe(false));
});

describe('analyze (temp repo)', () => {
  let dir;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const write = (rel, text, time) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
    if (time) utimesSync(join(dir, rel), time, time);
  };

  it('reports uncovered changed ranges from lcov and skips tests, unmeasured and stale', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcr-cov-'));
    write('src/a.ts', 'a\nb\nc\nd\ne\n', 1000);
    write('src/a.test.ts', 'x\n', 1000);
    write('src/b.ts', 'x\n', 1000);
    write('src/old.ts', 'x\n', 3000);
    write('README.md', 'x\n', 1000);
    write('node_modules/dep/coverage/lcov.info', 'SF:src/b.ts\nDA:1,0\nend_of_record\n', 2000);
    write('coverage/lcov.info', 'SF:src/a.ts\nDA:1,1\nDA:2,0\nDA:4,0\nDA:5,1\nend_of_record\nSF:src/old.ts\nDA:1,0\nend_of_record\nSF:src/a.test.ts\nDA:1,0\nend_of_record\n', 2000);
    expect(findReports(dir)).toEqual([{ path: 'coverage/lcov.info', format: 'lcov' }]);
    const files = ['src/a.ts', 'src/a.test.ts', 'src/b.ts', 'src/old.ts', 'README.md'];
    const { findings, notes } = await analyze({ root: dir, files, changes: { 'src/a.ts': [[1, 5]] } });
    expect(findings).toEqual([expect.objectContaining({ file: 'src/a.ts', line: 2, endLine: 4, message: '2 changed lines (2–4) are not run by any test.' })]);
    expect(notes).toContain('coverage: coverage report older than src/old.ts; rerun tests');
    expect(notes.some((n) => n.includes('1 changed source file(s) not in any coverage report') && n.includes('src/b.ts'))).toBe(true);
  });

  it('jacoco under target/ maps by suffix to src/main/java', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcr-cov-'));
    write('src/main/java/com/acme/Foo.java', 'x\n'.repeat(6), 1000);
    write('target/site/jacoco/jacoco.xml', JACOCO, 2000);
    const { findings } = await analyze({ root: dir, files: ['src/main/java/com/acme/Foo.java'], changes: {} });
    expect(findings).toEqual([expect.objectContaining({ line: 4, message: '1 changed line (4) is not run by any test.' })]);
  });

  it('go profile with go.mod module path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcr-cov-'));
    write('go.mod', 'module example.com/m\n\ngo 1.22\n', 1000);
    write('pkg/a.go', 'x\n'.repeat(12), 1000);
    write('cover.out', GO, 2000);
    const { findings } = await analyze({ root: dir, files: ['pkg/a.go'], changes: { 'pkg/a.go': [[1, 12]] } });
    expect(findings).toEqual([expect.objectContaining({ file: 'pkg/a.go', line: 7, endLine: 8 })]);
  });

  it('no report: no findings, one note', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcr-cov-'));
    write('src/a.ts', 'x\n');
    const { findings, notes } = await analyze({ root: dir, files: ['src/a.ts'], changes: {} });
    expect(findings).toEqual([]);
    expect(notes).toEqual(['coverage: no coverage report found; run your tests with coverage (lcov, Cobertura, JaCoCo, Go, SimpleCov) before review']);
  });
});
