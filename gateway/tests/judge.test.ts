import { describe, expect, it } from 'vitest';
import { classify, type Finding } from '../src/findings.ts';
import { applyAssessment, codeAround, findingRequest, tierByRules, tierFrom, toJudge } from '../src/judge.ts';

function finding(over: Partial<Parameters<typeof classify>[0]> = {}): Finding {
  return classify({ analyzer: 'correctness-semgrep', ruleId: 'r', message: 'm', file: 'src/a.ts', line: 3, endLine: 3, category: 'correctness', severity: 'high', ...over }, 'all', 'x');
}
const noul = (p: number) => ({ type: 'noul' as const, noul: p });

describe('judge policy', () => {
  it('only takes blocking away, and never for security', () => {
    expect(applyAssessment(finding(), { real: noul(0.05) }, 'jev').blocking).toBe(false);
    expect(applyAssessment(finding({ category: 'security' }), { real: noul(0.05) }, 'jev').blocking).toBe(true);
    expect(applyAssessment(finding({ severity: 'medium' }), { real: noul(0.99) }, 'jev').blocking).toBe(false);
    expect(applyAssessment(finding(), { real: noul(0.9) }, 'jev').assessment?.verdict).toBe('real');
  });

  it('turns speculative model findings into info', () => {
    const llm = finding({ analyzer: 'reliability-llm', category: 'reliability' });
    const out = applyAssessment(llm, { real: noul(0.55), concrete: noul(0.9), speculative: noul(0.85), style: noul(0.1) }, 'jev');
    expect(out.severity).toBe('low');
    expect(out.blocking).toBe(false);
    expect(out.assessment?.verdict).toBe('speculative');
  });

  it('asks speculation questions only about model findings, with past decisions as context', () => {
    expect(Object.keys(findingRequest(finding(), 'code', []).questions)).toEqual(['real']);
    const req = findingRequest(finding({ analyzer: 'security-llm' }), 'code', [
      { id: 'D-0001', action: 'false-positive', match: { rule: 'llm:r' }, reason: 'trusted input', decided_on: '2026-01-01' },
    ]);
    expect(Object.keys(req.questions)).toEqual(['real', 'concrete', 'speculative', 'style']);
    expect(JSON.stringify(req.state)).toContain('trusted input');
  });

  it('judges new undecided findings, blocking first', () => {
    const a = finding({ severity: 'low' });
    const b = finding({ line: 9 });
    expect(toJudge([a, b])[0]).toBe(b);
    expect(codeAround(['a', 'b', 'c'], 2, 2, 1)).toBe('      1| a\n>>    2| b\n      3| c');
  });
});

describe('risk tier', () => {
  const small = { files: [{ path: 'README.md', changedLines: 2 }], totalChangedLines: 2 };
  const auth = { files: [{ path: 'src/auth/login.ts', changedLines: 3 }], totalChangedLines: 3 };

  it('uses size and sensitive paths without the model', () => {
    expect(tierByRules(small)).toBe('trivial');
    expect(tierByRules(auth)).toBe('full');
  });

  it('trusts a confident model, but sensitive paths stay full', () => {
    expect(tierFrom(small, { type: 'score', score: 1.8, confidence: 0.9 })).toBe('full');
    expect(tierFrom(auth, { type: 'score', score: 0, confidence: 0.95 })).toBe('full');
    expect(tierFrom(small, { type: 'score', score: 1.8, confidence: 0.3 })).toBe('trivial');
  });
});

describe('judge policy for confident model findings', () => {
  it('keeps a model finding the judge thinks is real, even if it also looks speculative', () => {
    const llm = finding({ analyzer: 'reliability-llm', category: 'reliability', severity: 'medium' });
    const out = applyAssessment(llm, { real: noul(0.75), concrete: noul(0.9), speculative: noul(0.9), style: noul(0.02) }, 'jev');
    expect(out.severity).toBe('medium');
    expect(out.assessment?.verdict).toBe('real');
  });
});

describe('Jev budget', () => {
  it('keeps every request under 32k tokens, however large the input', async () => {
    const { estimateTokens, JEV_MAX_TOKENS, fitCode } = await import('../src/judge.ts');
    const huge = Array.from({ length: 5_000 }, (_, i) => `${i === 2_500 ? '>>' : '  '}${String(i).padStart(5)}| ${'x'.repeat(i % 7 === 0 ? 5_000 : 80)}`).join('\n');
    const req = findingRequest(finding({ message: 'm'.repeat(50_000) }), huge, []);
    expect(estimateTokens(req)).toBeLessThan(JEV_MAX_TOKENS);
    expect(String((req.state as { code: string }).code)).toContain('>> 2500|');
    expect(fitCode('a\nb', 100)).toBe('a\nb');
    const files = Array.from({ length: 20_000 }, (_, i) => ({ path: `src/very/long/path/to/module-${i}/file-${i}.ts`, changedLines: i }));
    const { tierRequest } = await import('../src/judge.ts');
    expect(estimateTokens(tierRequest({ files, totalChangedLines: 1 }))).toBeLessThan(JEV_MAX_TOKENS);
  });
});
