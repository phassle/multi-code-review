import { describe, expect, it } from 'vitest';
import { blockReason, gateEnabled, MAX_ROUNDS, nextRound } from './stop-gate.mjs';

describe('stop gate', () => {
  it('is opt-in: agent.gate in settings, or MCR_GATE', () => {
    expect(gateEnabled(undefined)).toBe(false);
    expect(gateEnabled('review:\n  security: maximum\n')).toBe(false);
    expect(gateEnabled('review:\n  security: maximum\nagent:\n  gate: true\n')).toBe(true);
    expect(gateEnabled('agent: # Claude Code\n\n  gate: yes # keep going\n')).toBe(true);
    expect(gateEnabled('agent:\n  gate: false\n')).toBe(false);
    expect(gateEnabled('review:\n  gate: true\n')).toBe(false); // not under agent
    expect(gateEnabled('agent:\n  other: 1\nreview:\n  gate: true\n')).toBe(false);
    expect(gateEnabled(undefined, { MCR_GATE: '1' })).toBe(true);
    expect(gateEnabled('agent:\n  gate: true\n', { MCR_GATE: 'off' })).toBe(false);
  });

  it('lists the blocking findings and tells the agent to fix, not silence', () => {
    const f = (i, blocking) => ({ id: `F-0000000${i}`, category: 'security', analyzer: 'semgrep', ruleId: `r${i}`, file: 'a.js', line: i, message: 'bad', blocking });
    const reason = blockReason({ blocking: 1, repoRoot: '/r', findings: [f(1, true), f(2, false)] });
    expect(reason).toContain('1 blocking finding(s) in /r');
    expect(reason).toContain('- [security] semgrep:r1 a.js:1 (F-00000001): bad');
    expect(reason).not.toContain('r2');
    expect(reason).toMatch(/ask the user/);
    const compact = blockReason({ blocking: 1, repoRoot: '/r', findings: [{ id: 'F-00000009', rule: 'mitre-attack:T1070-clear-traces', category: 'security', file: 'run.sh', line: 2, blocking: true }] });
    expect(compact).toContain('- [security] mitre-attack:T1070-clear-traces run.sh:2 (F-00000009)\n');
    const many = Array.from({ length: 25 }, (_, i) => f(i, true));
    expect(blockReason({ blocking: 25, repoRoot: '/r', findings: many })).toContain('… and 5 more');
  });

  it('counts rounds only while the hook keeps the agent going', () => {
    expect(nextRound(0, false)).toBe(1);
    expect(nextRound(2, false)).toBe(1);
    expect(nextRound(1, true)).toBe(2);
    expect(nextRound(MAX_ROUNDS, true)).toBeGreaterThan(MAX_ROUNDS);
  });
});
