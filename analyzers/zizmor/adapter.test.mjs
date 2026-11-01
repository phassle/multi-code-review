import { describe, expect, it } from 'vitest';
import { isActionsFile, notesFrom, severity, toFindings } from './adapter.mjs';

/** One zizmor json-v1 result, trimmed to the fields the adapter reads. */
function result(ident, sev, confidence, primary, extra = {}) {
  const loc = (kind, [r0, c0], [r1, c1], annotation) => ({
    symbolic: { key: { Local: { verbatim_path: primary.file } }, annotation, kind },
    concrete: { location: { start_point: { row: r0, column: c0 }, end_point: { row: r1, column: c1 } } },
  });
  return {
    ident,
    desc: extra.desc ?? ident,
    determinations: { severity: sev, confidence, persona: 'Regular' },
    locations: [loc('Hidden', [primary.from[0], 0], [primary.from[0] + 2, 0], 'this step'), loc('Primary', primary.from, primary.to, primary.annotation)],
    ignored: extra.ignored ?? false,
  };
}

describe('zizmor analyzer', () => {
  it('maps severity and confidence: High blocks only when zizmor is fairly sure', () => {
    expect(severity({ severity: 'High', confidence: 'High' })).toBe('high');
    expect(severity({ severity: 'High', confidence: 'Medium' })).toBe('high');
    expect(severity({ severity: 'High', confidence: 'Low' })).toBe('medium');
    expect(severity({ severity: 'Medium', confidence: 'High' })).toBe('medium');
    expect(severity({ severity: 'Low', confidence: 'High' })).toBe('low');
    expect(severity({ severity: 'Informational', confidence: 'High' })).toBe('low');
    expect(severity({ severity: 'Unknown', confidence: 'Unknown' })).toBe('low');
    expect(severity(undefined)).toBe('low');
  });

  it('reports the primary location, 1-based, with the audit id and docs link', () => {
    const report = [
      result('template-injection', 'High', 'High', { file: '.github/workflows/ci.yml', from: [11, 23], to: [11, 47], annotation: 'may expand into attacker-controllable code' }, { desc: 'code injection via template expansion' }),
      result('excessive-permissions', 'Medium', 'Medium', { file: '.github/workflows/ci.yml', from: [5, 2], to: [12, 0], annotation: 'default permissions used due to no permissions: block' }),
      result('unpinned-uses', 'High', 'Low', { file: 'sub/action.yml', from: [5, 12], to: [5, 30] }),
    ];
    const findings = toFindings(report);
    expect(findings.map((f) => [f.ruleId, f.file, f.line, f.endLine, f.column, f.severity, f.category])).toEqual([
      ['template-injection', '.github/workflows/ci.yml', 12, undefined, 24, 'high', 'security'],
      ['excessive-permissions', '.github/workflows/ci.yml', 6, 12, 3, 'medium', 'security'],
      ['unpinned-uses', 'sub/action.yml', 6, undefined, 13, 'medium', 'security'],
    ]);
    expect(findings[0]).toMatchObject({
      message: 'code injection via template expansion: may expand into attacker-controllable code (zizmor confidence: High)',
      helpUri: 'https://docs.zizmor.sh/audits/#template-injection',
      ruleName: 'code injection via template expansion',
    });
  });

  it('skips ignored results and results without a local location', () => {
    const ignored = result('artipacked', 'Medium', 'Low', { file: 'a/action.yml', from: [1, 0], to: [1, 5] }, { ignored: true });
    expect(toFindings([ignored, { ident: 'x', locations: [] }])).toEqual([]);
  });

  it('only audits workflows and composite actions', () => {
    expect(
      ['.github/workflows/ci.yml', '.github/workflows/release.yaml', 'action.yml', 'actions/setup/action.yaml', '.github/dependabot.yml', '.github/workflows/sub/x.yml', 'config.yml', 'my-action.yml'].map(isActionsFile),
    ).toEqual([true, true, true, true, false, false, false, false]);
  });

  it('notes inputs zizmor skipped as unparseable', () => {
    const stderr = [
      ' INFO zizmor: 🌈 zizmor v1.31.1',
      " WARN collect_inputs: zizmor::registry::input: failed to parse input: did not find expected ',' or ']' at line 2 column 5",
      ' INFO audit: zizmor: 🌈 completed sub/action.yml',
    ].join('\n');
    expect(notesFrom(['.github/workflows/broken.yml', 'sub/action.yml'], stderr)).toEqual([
      'zizmor: skipped .github/workflows/broken.yml (not a valid workflow or action)',
      "zizmor: failed to parse input: did not find expected ',' or ']' at line 2 column 5",
    ]);
    expect(notesFrom(['sub/action.yml'], ' INFO audit: zizmor: 🌈 completed sub/action.yml')).toEqual([]);
  });
});
