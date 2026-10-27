import { describe, expect, it } from 'vitest';
import { exitCode, parseArgs, toolCall } from './mcr.mjs';

describe('mcr cli', () => {
  it('parses a review with repeatable and value flags', () => {
    const p = parseArgs(['review', '/repo', '--base', 'origin/main', '--category', 'security', '--category', 'testing', '--all', '--json']);
    expect(p).toMatchObject({ command: 'review', path: '/repo', flags: { base: 'origin/main', category: ['security', 'testing'], all: true, json: true } });
  });

  it('rejects unknown commands, options and missing values', () => {
    expect(parseArgs([]).error).toBe('no command');
    expect(parseArgs(['lint']).error).toMatch(/unknown command/);
    expect(parseArgs(['review', '--nope']).error).toMatch(/unknown option/);
    expect(parseArgs(['review', '--base']).error).toMatch(/needs a value/);
    expect(parseArgs(['triage', '--analyzer', 'semgrep']).error).toMatch(/only works with review/);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('maps commands to MCP tools', () => {
    expect(toolCall(parseArgs(['review', '--all', '--preexisting']), '/r')).toEqual({ name: 'run_review', arguments: { path: '/r', scope: 'all', include_preexisting: true } });
    expect(toolCall(parseArgs(['review', '--analyzer', 'semgrep']), '/r')).toEqual({ name: 'run_analyzer', arguments: { path: '/r', analyzers: ['semgrep'] } });
    expect(toolCall(parseArgs(['fix-report', '--base', 'main']), '/r')).toEqual({ name: 'fix_report', arguments: { path: '/r', base: 'main' } });
    expect(toolCall(parseArgs(['detect', '--base', 'main']), '/r')).toEqual({ name: 'detect_stack', arguments: { path: '/r' } });
    expect(toolCall(parseArgs(['analyzers']), '/r')).toEqual({ name: 'list_analyzers', arguments: {} });
  });

  it('exits 1 on blocking, and on analyzer errors only when strict', () => {
    expect(exitCode('review', { blocking: 2, analyzers: [] }, false)).toBe(1);
    expect(exitCode('review', { blocking: 0, analyzers: [{ name: 'x', error: 'boom' }] }, false)).toBe(0);
    expect(exitCode('review', { blocking: 0, analyzers: [{ name: 'x', error: 'boom' }] }, true)).toBe(1);
    expect(exitCode('triage', { blocking: 3 }, true)).toBe(0);
  });
});
