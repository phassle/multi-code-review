// TypeScript/JavaScript: the target repo's own ESLint (its config is the norm)
// and tsc. Both come from the repo's node_modules, so its rules and versions
// apply; this image only brings Node. ESLint configs are code, which is why the
// analyzer network has no egress.
//
// MCR_TOOLS picks the tool for this container: "tsc" (correctness-tsc) or
// "eslint" (architecture-eslint, reliability-eslint, ...: one container per
// category, each keeping only the ESLint findings in its category).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { run, serve } from '../_kit/serve.mjs';

const TOOLS = (process.env.MCR_TOOLS ?? 'eslint,tsc').split(',').map((t) => t.trim());

const info = {
  name: TOOLS.join('+'),
  version: process.version,
  languages: ['typescript', 'javascript'],
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
};

const LINTABLE = /\.(?:[cm]?[jt]sx?)$/;

// Rules a repo uses to encode its own boundaries are architecture findings.
const ARCHITECTURE = new Set(['no-restricted-syntax', 'no-restricted-imports', 'no-restricted-globals', 'import/no-cycle', 'boundaries/element-types']);
const SECURITY = new Set(['no-eval', 'no-implied-eval', 'no-new-func', 'no-script-url', 'react/no-danger', '@next/next/no-script-component-in-head']);
const RELIABILITY = new Set(['@typescript-eslint/no-floating-promises', '@typescript-eslint/no-misused-promises', '@typescript-eslint/require-await', 'no-async-promise-executor', 'require-atomic-updates', 'react-hooks/exhaustive-deps']);
const CORRECTNESS = new Set(['react-hooks/rules-of-hooks', 'no-undef', 'no-unreachable', 'no-fallthrough', 'no-self-compare', 'no-dupe-keys', 'no-dupe-else-if', 'no-cond-assign', 'no-constant-condition', 'valid-typeof', 'use-isnan', 'no-unsafe-finally', 'no-unsafe-negation']);
const TESTING = /^(?:vitest|jest|playwright|testing-library)\//;

export function eslintCategory(ruleId) {
  if (!ruleId) return 'correctness'; // parse errors
  if (ARCHITECTURE.has(ruleId)) return 'architecture';
  if (SECURITY.has(ruleId) || ruleId.startsWith('security/')) return 'security';
  if (RELIABILITY.has(ruleId)) return 'reliability';
  if (CORRECTNESS.has(ruleId) || ruleId.startsWith('@typescript-eslint/no-unsafe-')) return 'correctness';
  if (TESTING.test(ruleId)) return 'testing';
  return 'best-practices';
}

/** `src/a.ts(12,5): error TS2322: Type ...` -> finding */
export function parseTsc(stdout) {
  const findings = [];
  for (const line of stdout.split('\n')) {
    const m = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(line.trim());
    if (!m) continue;
    findings.push({
      ruleId: m[5],
      message: m[6],
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      category: 'correctness',
      severity: m[4] === 'error' ? 'high' : 'medium',
      helpUri: `https://typescript.tv/errors/#${m[5].toLowerCase()}`,
    });
  }
  return findings;
}

async function eslint(root, files, notes) {
  const bin = join(root, 'node_modules/eslint/bin/eslint.js');
  if (!existsSync(bin)) {
    notes.push('eslint skipped: node_modules/eslint not found in the repo (run npm ci).');
    return [];
  }
  const targets = files.filter((f) => LINTABLE.test(f));
  if (targets.length === 0) return [];
  const result = await run('node', [bin, '--format', 'json', '--no-warn-ignored', '--', ...targets], { cwd: root });
  let reports;
  try {
    reports = JSON.parse(result.stdout);
  } catch {
    notes.push(`eslint failed (exit ${result.code}): ${result.stderr.slice(0, 400)}`);
    return [];
  }
  return reports.flatMap((report) =>
    report.messages.map((m) => ({
      ruleId: m.ruleId ?? 'parse-error',
      message: m.message,
      file: report.filePath.startsWith(root) ? report.filePath.slice(root.length + 1) : report.filePath,
      line: m.line ?? 1,
      endLine: m.endLine,
      column: m.column,
      category: eslintCategory(m.ruleId),
      severity: m.severity === 2 ? 'high' : 'low',
      helpUri: m.ruleId && !m.ruleId.includes('/') ? `https://eslint.org/docs/latest/rules/${m.ruleId}` : undefined,
    })),
  );
}

async function tsc(root, notes) {
  const bin = join(root, 'node_modules/typescript/bin/tsc');
  if (!existsSync(join(root, 'tsconfig.json'))) return [];
  if (!existsSync(bin)) {
    notes.push('tsc skipped: node_modules/typescript not found in the repo (run npm ci).');
    return [];
  }
  // The repo is mounted read-only: never emit, and keep any build info in /tmp.
  const result = await run('node', [bin, '--noEmit', '--pretty', 'false', '--tsBuildInfoFile', '/tmp/mcr.tsbuildinfo', '-p', root], { cwd: root });
  return parseTsc(result.stdout);
}

async function analyze({ root, files }) {
  const notes = [];
  const [lint, types] = await Promise.all([
    TOOLS.includes('eslint') ? eslint(root, files, notes) : [],
    TOOLS.includes('tsc') ? tsc(root, notes) : [],
  ]);
  return { findings: [...lint, ...types], notes };
}

if (process.env.MCR_ROOT) serve({ info, analyze });
