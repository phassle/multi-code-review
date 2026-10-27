// Java: PMD. The repo's own ruleset when it has one (its config is the norm),
// else PMD's quickstart set plus the security category. PMD files every rule
// under a category (its "ruleset" in the report); that decides ours.

import { existsSync, writeFileSync } from 'node:fs';
import { join, isAbsolute, relative } from 'node:path';
import { run, serve } from '../_kit/serve.mjs';

const version = (await run('pmd', ['--version'])).stdout.trim().split('\n')[0] ?? 'pmd';

const info = { name: 'pmd', version, languages: ['java'], extensions: ['.java'] };

const DEFAULT_RULESETS = 'rulesets/java/quickstart.xml,category/java/security.xml';
const REPO_RULESETS = ['pmd.xml', 'pmd-ruleset.xml', 'ruleset.xml', '.pmd/ruleset.xml', 'config/pmd/ruleset.xml', 'config/pmd/pmd.xml'];

const CATEGORY = {
  Security: 'security',
  Design: 'architecture',
  'Error Prone': 'correctness',
  Multithreading: 'reliability',
  Performance: 'reliability',
};

export function pmdCategory(ruleset) {
  return CATEGORY[ruleset] ?? 'best-practices';
}

/** PMD priority 1 (worst) .. 5. */
export function pmdSeverity(priority) {
  return priority <= 2 ? 'high' : priority === 3 ? 'medium' : 'low';
}

/** PMD's JSON report -> findings with paths relative to root. */
export function parsePmd(json, root) {
  return (json.files ?? []).flatMap((file) =>
    (file.violations ?? []).map((v) => ({
      ruleId: v.rule,
      message: String(v.description ?? v.rule).trim(),
      file: isAbsolute(file.filename) ? relative(root, file.filename) : file.filename,
      line: v.beginline ?? 1,
      endLine: v.endline,
      column: v.begincolumn,
      category: pmdCategory(v.ruleset),
      severity: pmdSeverity(Number(v.priority ?? 3)),
      helpUri: v.externalInfoUrl,
    })),
  );
}

async function analyze({ root, files }) {
  const targets = files.filter((f) => f.endsWith('.java'));
  if (targets.length === 0) return { findings: [], notes: [] };
  const own = REPO_RULESETS.find((r) => existsSync(join(root, r)));
  const list = `/tmp/pmd-files-${process.pid}-${Date.now()}.txt`;
  writeFileSync(list, targets.map((f) => join(root, f)).join('\n'));
  const result = await run(
    'pmd',
    ['check', '--file-list', list, '-R', own ? join(root, own) : DEFAULT_RULESETS, '-f', 'json', '--no-cache', '--no-progress', '--no-fail-on-violation', '--no-fail-on-error'],
    { cwd: root },
  );
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`pmd failed (exit ${result.code}): ${result.stderr.slice(0, 500)}`);
  }
  const notes = (parsed.processingErrors ?? []).slice(0, 10).map((e) => `${relative(root, e.filename ?? '')}: ${String(e.message ?? '').split('\n')[0]}`);
  if (own) notes.push(`pmd: using the repo's ruleset ${own}`);
  return { findings: parsePmd(parsed, root), notes };
}

if (process.env.MCR_ROOT) serve({ info, analyze });
