// Semgrep with the community rules baked into the image (no network at run time),
// split by category at build time: this container loads /rules/<MCR_CATEGORY>.
// A low-confidence rule never blocks.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { run, serve } from '../_kit/serve.mjs';

const RULES = process.env.SEMGREP_RULES ?? '/rules';

const version = (await run('semgrep', ['--version'])).stdout.trim();

const info = {
  name: 'semgrep',
  version,
  languages: ['typescript', 'javascript', 'python', 'go', 'java', 'kotlin', 'scala', 'csharp', 'ruby', 'php', 'rust', 'c', 'swift', 'dockerfile', 'yaml', 'bash'],
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.java', '.kt', '.kts', '.scala', '.cs', '.rb', '.php', '.rs', '.c', '.h', '.swift', '.yml', '.yaml', '.properties', '.sh', 'Dockerfile'],
};

export function severityOf(semgrepSeverity, metadata = {}) {
  const base = { ERROR: 'high', WARNING: 'medium', INFO: 'low' }[semgrepSeverity] ?? 'medium';
  return base === 'high' && String(metadata.confidence ?? '').toUpperCase() === 'LOW' ? 'medium' : base;
}

async function analyze({ root, files, category }) {
  const rules = join(RULES, category);
  if (!existsSync(rules)) return { findings: [], notes: [`no semgrep rules for ${category}`] };
  if (files.length === 0) return { findings: [], notes: [] };
  const result = await run(
    'semgrep',
    ['scan', '--config', rules, '--json', '--metrics=off', '--disable-version-check', '--quiet', '--', ...files],
    { cwd: root, env: { ...process.env, HOME: '/tmp' } },
  );
  // Semgrep exits 1 when it has findings; anything without parseable JSON is a failure.
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`semgrep failed (exit ${result.code}): ${result.stderr.slice(0, 500)}`);
  }
  const findings = (parsed.results ?? []).map((r) => {
    const metadata = r.extra?.metadata ?? {};
    return {
      // The id carries the rules folder (rules.<category>.); drop it so the id does not depend on the split.
      ruleId: r.check_id.replace(/^rules\.(?:security|correctness|reliability|best-practices)\./, ''),
      message: String(r.extra?.message ?? r.check_id).trim(),
      file: r.path,
      line: r.start?.line ?? 1,
      endLine: r.end?.line,
      column: r.start?.col,
      category,
      severity: severityOf(r.extra?.severity, metadata),
      helpUri: metadata.source ?? (Array.isArray(metadata.references) ? metadata.references[0] : undefined),
    };
  });
  const notes = (parsed.errors ?? []).slice(0, 20).map((e) => `${e.path ?? ''} ${e.message ?? e.type ?? ''}`.trim());
  return { findings, notes };
}

if (process.env.MCR_ROOT) serve({ info, analyze });
