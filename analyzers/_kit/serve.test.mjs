import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkRequest, run, toSarif } from './serve.mjs';

describe('analyzer kit', () => {
  it('kills a tool that runs past its timeout', async () => {
    const started = Date.now();
    const r = await run('sleep', ['10'], { timeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.code).toBe(-1);
    expect(r.stderr).toContain('sleep killed after 0.2 s');
  });

  it('returns the output of a tool that finishes', async () => {
    expect(await run('echo', ['hi'])).toMatchObject({ code: 0, stdout: 'hi\n' });
  });

  it('accepts roots inside MCR_ROOT and rejects siblings, symlinks out and escaping files', () => {
    const base = mkdtempSync(join(tmpdir(), 'mcr-kit-'));
    const mcrRoot = join(base, 'data');
    mkdirSync(join(mcrRoot, 'repo'), { recursive: true });
    mkdirSync(join(base, 'data-other'));
    symlinkSync(join(base, 'data-other'), join(mcrRoot, 'link'));
    expect(checkRequest({ root: join(mcrRoot, 'repo'), files: ['a.ts'] }, mcrRoot).files).toEqual(['a.ts']);
    expect(() => checkRequest({ root: join(base, 'data-other'), files: [] }, mcrRoot)).toThrow(/outside MCR_ROOT/);
    expect(() => checkRequest({ root: join(mcrRoot, 'link'), files: [] }, mcrRoot)).toThrow(/outside MCR_ROOT/);
    expect(() => checkRequest({ root: join(mcrRoot, 'repo'), files: ['../x'] }, mcrRoot)).toThrow(/escapes root/);
    expect(() => checkRequest({ root: 'relative', files: [] }, mcrRoot)).toThrow(/absolute/);
  });

  it('writes SARIF with one rule per ruleId, severity as level, and notes as notifications', () => {
    const f = { ruleId: 'r1', message: 'm', file: 'a.ts', line: 3, category: 'security', severity: 'high', helpUri: 'https://x' };
    const sarif = toSarif({ name: 't', version: '1' }, [f, { ...f, line: 9, endLine: 10, column: 2, severity: 'low' }], ['skipped b.ts']);
    const run0 = sarif.runs[0];
    expect(sarif.version).toBe('2.1.0');
    expect(run0.tool.driver.rules).toEqual([{ id: 'r1', helpUri: 'https://x' }]);
    expect(run0.results.map((r) => r.level)).toEqual(['error', 'note']);
    expect(run0.results[0].locations[0].physicalLocation.region).toEqual({ startLine: 3 });
    expect(run0.results[1].locations[0].physicalLocation.region).toEqual({ startLine: 9, endLine: 10, startColumn: 2 });
    expect(run0.results[0].properties).toEqual({ category: 'security', severity: 'high' });
    expect(run0.invocations[0].toolExecutionNotifications).toEqual([{ message: { text: 'skipped b.ts' }, level: 'warning' }]);
  });
});
