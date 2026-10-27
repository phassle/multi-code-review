import { describe, expect, it } from 'vitest';
import { buildErrors, dedupe, owningProjects, parseSarif, roslynCategory, roslynSeverity } from './adapter.mjs';

describe('roslyn analyzer', () => {
  it('maps Roslyn rule categories onto ours', () => {
    expect(roslynCategory('CA5351', 'Security')).toBe('security');
    expect(roslynCategory('CA2000', 'Reliability')).toBe('reliability');
    expect(roslynCategory('CA1850', 'Performance')).toBe('reliability');
    expect(roslynCategory('CA2208', 'Usage')).toBe('correctness');
    expect(roslynCategory('CS0219', 'Compiler')).toBe('correctness');
    expect(roslynCategory('CA1062', 'Design')).toBe('architecture');
    expect(roslynCategory('CA1707', 'Naming')).toBe('best-practices');
    expect(roslynCategory('IDE0005', 'Style')).toBe('best-practices');
  });

  it('falls back to the rule id prefix without a category', () => {
    expect(roslynCategory('CS8602')).toBe('correctness');
    expect(roslynCategory('CA3075')).toBe('security');
    expect(roslynCategory('CA5350')).toBe('security');
    expect(roslynCategory('CA2100')).toBe('security');
    expect(roslynCategory('CA2326')).toBe('security');
    expect(roslynCategory('CA2016')).toBe('reliability');
    expect(roslynCategory('CA2201')).toBe('correctness');
    expect(roslynCategory('CA1822')).toBe('reliability');
    expect(roslynCategory('CA1050')).toBe('architecture');
    expect(roslynCategory('CA1707')).toBe('best-practices');
    expect(roslynCategory('IDE0059')).toBe('best-practices');
  });

  it('maps SARIF levels onto severities', () => {
    expect(roslynSeverity('error')).toBe('high');
    expect(roslynSeverity('warning')).toBe('medium');
    expect(roslynSeverity(undefined)).toBe('medium');
    expect(roslynSeverity('note')).toBe('low');
    expect(roslynSeverity('none')).toBe(null);
  });

  it('parses SARIF 2.1 for the wanted files, relative to the root', () => {
    const log = {
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'csc', rules: [{ id: 'CA5351', shortDescription: { text: 'Do Not Use Broken Cryptographic Algorithms' }, helpUri: 'https://learn', properties: { category: 'Security' } }] } },
          results: [
            { ruleId: 'CA5351', level: 'warning', message: { text: 'Uses MD5' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///repo/src/A.cs' }, region: { startLine: 11, endLine: 11, startColumn: 20 } } }] },
            { ruleId: 'CS0219', level: 'error', message: { text: 'Unused' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/A.cs', uriBaseId: 'SRC' }, region: { startLine: 3 } } }] },
            { ruleId: 'CA5351', level: 'warning', message: { text: 'Other file' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///repo/src/B.cs' }, region: { startLine: 1 } } }] },
            { ruleId: 'CA5351', level: 'warning', message: { text: 'Suppressed' }, suppressions: [{ kind: 'inSource' }], locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///repo/src/A.cs' }, region: { startLine: 2 } } }] },
            { ruleId: 'IDE0005', level: 'none', message: { text: 'Hidden' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///repo/src/A.cs' }, region: { startLine: 1 } } }] },
          ],
          originalUriBaseIds: { SRC: { uri: 'file:///repo/' } },
        },
      ],
    };
    expect(parseSarif(log, '/repo', ['src/A.cs'])).toEqual([
      { ruleId: 'CA5351', message: 'Uses MD5', file: 'src/A.cs', line: 11, endLine: 11, column: 20, category: 'security', severity: 'medium', helpUri: 'https://learn', ruleName: 'Do Not Use Broken Cryptographic Algorithms' },
      { ruleId: 'CS0219', message: 'Unused', file: 'src/A.cs', line: 3, category: 'correctness', severity: 'high' },
    ]);
  });

  it('parses SARIF 1.0 as older compilers write it', () => {
    const log = {
      version: '1.0.0',
      runs: [
        {
          rules: { CA2000: { id: 'CA2000', properties: { category: 'Reliability' } } },
          results: [{ ruleId: 'CA2000', level: 'warning', message: 'Dispose objects', locations: [{ resultFile: { uri: 'file:///repo/A.cs', region: { startLine: 7, startColumn: 9 } } }] }],
        },
      ],
    };
    expect(parseSarif(log, '/repo', ['A.cs'])).toEqual([
      { ruleId: 'CA2000', message: 'Dispose objects', file: 'A.cs', line: 7, column: 9, category: 'reliability', severity: 'medium' },
    ]);
  });

  it('drops duplicate findings', () => {
    const f = { ruleId: 'CA5351', file: 'A.cs', line: 1, message: 'x' };
    expect(dedupe([f, { ...f }, { ...f, line: 2 }])).toHaveLength(2);
  });

  it('finds the nearest owning project, preferring the language project', () => {
    const dirs = {
      '/repo': ['App.sln'],
      '/repo/src/App': ['App.csproj', 'App.vbproj', 'Program.cs'],
      '/repo/src/App/Sub': ['Util.cs', 'Mod.vb'],
      '/repo/tools': ['run.cs'],
    };
    const { projects, orphans } = owningProjects('/repo', ['src/App/Program.cs', 'src/App/Sub/Util.cs', 'src/App/Sub/Mod.vb', 'tools/run.cs'], (d) => dirs[d] ?? []);
    expect([...projects]).toEqual([
      ['/repo/src/App/App.csproj', ['src/App/Program.cs', 'src/App/Sub/Util.cs']],
      ['/repo/src/App/App.vbproj', ['src/App/Sub/Mod.vb']],
    ]);
    expect(orphans).toEqual(['tools/run.cs']);
  });

  it('extracts MSBuild error lines', () => {
    const out = '/p/A.csproj : error NETSDK1004: Assets file not found. [/p/A.csproj]\n  warning CS0168: x\n/p/A.csproj : error NETSDK1004: Assets file not found. [/p/A.csproj]\n';
    expect(buildErrors(out)).toEqual(['/p/A.csproj : error NETSDK1004: Assets file not found.']);
  });
});
