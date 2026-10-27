import { describe, expect, it } from 'vitest';
import { helpUri, isDockerfile, toFindings } from './adapter.mjs';

describe('hadolint analyzer', () => {
  it('maps levels to severity: errors block, style is info', () => {
    const report = [
      { code: 'DL3000', level: 'error', message: 'Use absolute WORKDIR', file: 'Dockerfile', line: 3, column: 1 },
      { code: 'DL3008', level: 'warning', message: 'Pin versions', file: 'Dockerfile', line: 2, column: 1 },
      { code: 'SC2086', level: 'info', message: 'Double quote', file: 'api/Dockerfile', line: 5, column: 1 },
    ];
    expect(toFindings(report).map((f) => [f.ruleId, f.severity, f.category])).toEqual([
      ['DL3000', 'high', 'best-practices'],
      ['DL3008', 'medium', 'best-practices'],
      ['SC2086', 'low', 'best-practices'],
    ]);
  });

  it('links hadolint and ShellCheck rules to their docs', () => {
    expect(helpUri('DL3008')).toBe('https://github.com/hadolint/hadolint/wiki/DL3008');
    expect(helpUri('SC2086')).toBe('https://www.shellcheck.net/wiki/SC2086');
  });

  it('only lints Dockerfiles', () => {
    expect(['Dockerfile', 'api/Dockerfile.prod', 'web.dockerfile', 'app/config.js'].map(isDockerfile)).toEqual([true, true, true, false]);
  });
});
